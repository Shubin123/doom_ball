// DOOM Balloon page: the payload's DOOM, its downlink and the ground station
// in one loop, plus the system, radio chains, OBC and repositories, all read
// from the UVic Satellite Design sources under uvsd/.
import { DoomSim } from '../doom-sim.js';
import { NUM_PIXELS, encodeFramePacket, FrameParser, decodeFramePayload, parsePalettes, KEY_SAMPLE_MS, CODE_TO_HID, modifierBit, keystroke, keyboardPackets, parseUplink, doomKeysFor, FRAME_TYPE_DOOM_FRAME } from './protocol.js';
import { BLOCKS, LINKS, UPLINK_COMMANDS, BURNWIRE } from './system.js';
import { readObc, OBC_FILES } from './obc-source.js';
import { parseGrc, signalChains, evaluate } from './grc.js';
import { PHY_DEFAULTS, FRAME_FORMATS, frameBytes, bytesToSymbols, encodeTestFrame, decodeTestFrame, FskModulator, Channel, FskDemodulator, TestFrameReceiver, spectrum } from './modem.js';

const byId = (id) => document.getElementById(id);
const GITHUB = 'https://github.com/UVicSatelliteDesign';
const GRC_PATH = 'uvsd/uvsd-doom-gnu-radio/DOOMflow.grc';
const PALETTE_PATH = 'uvsd/uvsd-doom-gs/assets/palettes.hex';
const RECORDINGS = {
  'rec-grey': { path: 'uvsd/uvsd-doom-gnu-radio/doom_raw.bin', format: 'grey' },
  'rec-colour': { path: 'uvsd/uvsd-doom-gnu-radio/colour gameplay/doom_raw_rgb.bin', format: 'colour' },
};
const UART_BYTES_PER_S = 115200 / 10;      // 8N1, n_frame_uart.c
const MAX_SYMBOLS_PER_TICK = 48000;        // keeps a slow machine responsive; the link then runs slower than real time
const ideLink = (path) => `index.html#open=${encodeURIComponent(path)}`;
const html = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const hex = (bytes, max = 24) => [...bytes.slice(0, max)].map((b) => b.toString(16).padStart(2, '0')).join(' ') + (bytes.length > max ? ' …' : '');
const fmtRate = (bps) => (bps >= 1e6 ? `${(bps / 1e6).toFixed(2)} Mbit/s` : `${(bps / 1e3).toFixed(1)} kbit/s`);
const fmtHz = (hz) => (Math.abs(hz) >= 1e6 ? `${+(hz / 1e6).toFixed(3)} MHz` : Math.abs(hz) >= 1e3 ? `${+(hz / 1e3).toFixed(1)} kHz` : `${hz} Hz`);

// Sources come from the checkout (local server, Pages); opened from disk the
// page falls back to the snapshot in ide/uvsd-sources.js.
async function readText(path) {
  try {
    const response = await fetch(encodeURI(path));
    if (response.ok) return await response.text();
  } catch { /* file:// or offline */ }
  const text = window.UVSD_SOURCES?.files?.[path];
  if (text == null) throw new Error(`could not load ${path}`);
  return text;
}
async function readBinary(path) {
  const response = await fetch(encodeURI(path));
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}
function stats(el, rows) {
  el.innerHTML = rows.map(([k, v]) => `<div><dt>${html(k)}</dt><dd>${html(v)}</dd></div>`).join('');
}
function setState(el, text, kind = '') { el.textContent = text; el.className = `state ${kind}`; }

// ---------------------------------------------------------------- state

const ui = {
  payload: byId('payload-screen'), ground: byId('ground-screen'),
  source: byId('source'), path: byId('path'), format: byId('format'), snr: byId('snr'), cfo: byId('cfo'), batch: byId('batch'),
};
const groundCtx = ui.ground.getContext('2d');
const groundImage = groundCtx.createImageData(320, 200);
const payloadCtx = ui.payload.getContext('2d');
const payloadImage = payloadCtx.createImageData(320, 200);
for (const [id, f] of Object.entries(FRAME_FORMATS)) ui.format.add(new Option(f.label, id));

const phy = { ...PHY_DEFAULTS };
let palettes = [];
let running = false;
let doom = null;
const live = { rgba: null, indexed: null, playpal: 0, frames: 0 };
const recordings = {};
let link = null;

const uplink = { held: new Set(), samples: [], batch: 0, queue: [], lastKeyAt: 0, recording: false, sent: 0, delivered: 0 };
const payloadKeys = { queue: [], held: new Set(), releaseAt: 0, applied: 0 };
let trUntil = 0;

function log(text, cls = '') {
  const el = byId('uplink-log');
  const line = document.createElement('div');
  if (cls) line.className = cls;
  line.textContent = text;
  el.appendChild(line);
  while (el.childElementCount > 200) el.firstChild.remove();
  el.scrollTop = el.scrollHeight;
}

// ---------------------------------------------------------------- downlink

function newLink() {
  const path = ui.path.value;
  const rec = RECORDINGS[ui.source.value];
  const format = FRAME_FORMATS[rec ? rec.format : ui.format.value];
  const channel = new Channel(phy);
  channel.snrDb = Number(ui.snr.value);
  channel.offsetHz = Number(ui.cfo.value) * 1e3;
  return {
    path, format, rec, channel,
    mod: new FskModulator(phy), demod: new FskDemodulator(phy),
    receiver: new TestFrameReceiver(format), parser: new FrameParser(),
    tx: null, sentFrames: 0, sentBytes: 0, rxFrames: 0, recIndex: 0, carry: 0,
    lastIq: null, recent: new Float32Array(0), pendingRef: [], symErrors: null,
    started: performance.now(), linkTime: 0, wallTime: 0, rxTimes: [], lastFix: 0, lastRle: 0,
  };
}

function nextTxFrame() {
  if (link.path === 'uart') {
    if (!live.indexed) return null;
    const packet = encodeFramePacket(live.indexed, live.playpal);
    link.lastRle = packet.length;
    return { bytes: packet, playpal: live.playpal };
  }
  if (link.rec) {
    const data = recordings[ui.source.value];
    if (!data) return null;
    const size = frameBytes(link.format) + 4;
    const count = Math.floor(data.length / size);
    const frame = data.subarray((link.recIndex % count) * size, (link.recIndex % count + 1) * size);
    link.recIndex++;
    decodeTestFrame(bytesToSymbols(frame.subarray(4)), link.format, payloadImage.data);
    payloadCtx.putImageData(payloadImage, 0, 0);
    return { bytes: frame, symbols: bytesToSymbols(frame), fixes: 0 };
  }
  if (!live.rgba) return null;
  const { frame, fixes } = encodeTestFrame(live.rgba, link.format);
  link.lastFix = fixes;
  return { bytes: frame, symbols: bytesToSymbols(frame), fixes };
}

function frameDone() {
  link.sentFrames++;
  link.sentBytes += link.tx.bytes.length;
  // The radio turns around between frames, so queued uplink commands go up now.
  if (link.path === 'rf') deliverUplink();
  link.tx = null;
}

function rfStep(dtMs) {
  let budget = Math.min(MAX_SYMBOLS_PER_TICK, Math.floor((dtMs / 1000) * phy.symbolRate));
  const realtimeShare = budget / Math.max(1, (dtMs / 1000) * phy.symbolRate);
  link.linkTime += budget / phy.symbolRate; link.wallTime += dtMs / 1000;
  while (budget > 0) {
    if (!link.tx) {
      link.tx = nextTxFrame();
      if (!link.tx) break;
      link.tx.pos = 0;
      link.pendingRef.push(link.tx.symbols.subarray(16));
      if (link.pendingRef.length > 4) link.pendingRef.shift();
    }
    const n = Math.min(budget, link.tx.symbols.length - link.tx.pos);
    const iq = link.channel.apply(link.mod.modulate(link.tx.symbols.subarray(link.tx.pos, link.tx.pos + n)));
    link.tx.pos += n; budget -= n;
    link.lastIq = iq;
    const values = link.demod.demodulate(iq);
    const merged = new Float32Array(link.recent.length + values.length);
    merged.set(link.recent); merged.set(values, link.recent.length);
    link.recent = merged.length > 2400 ? merged.slice(merged.length - 2400) : merged;
    for (const symbols of link.receiver.push(values)) {
      const ref = link.pendingRef.shift();
      if (ref && ref.length === symbols.length) {
        let errors = 0;
        for (let i = 0; i < ref.length; i++) if (ref[i] !== symbols[i]) errors++;
        link.symErrors = { errors, total: ref.length };
      }
      decodeTestFrame(symbols, link.format, groundImage.data);
      groundCtx.putImageData(groundImage, 0, 0);
      link.rxFrames++; link.rxTimes.push(performance.now());
    }
    if (link.tx.pos >= link.tx.symbols.length) frameDone();
  }
  link.realtime = realtimeShare;
}

function uartStep(dtMs) {
  link.carry += (dtMs / 1000) * UART_BYTES_PER_S;
  link.linkTime += dtMs / 1000; link.wallTime += dtMs / 1000;
  while (link.carry >= 1) {
    if (!link.tx) {
      link.tx = nextTxFrame();
      if (!link.tx) { link.carry = 0; break; }
      link.tx.pos = 0;
    }
    const n = Math.min(Math.floor(link.carry), link.tx.bytes.length - link.tx.pos);
    const chunk = link.tx.bytes.subarray(link.tx.pos, link.tx.pos + n);
    link.tx.pos += n; link.carry -= n;
    for (const packet of link.parser.push(chunk)) {
      if (packet.type !== FRAME_TYPE_DOOM_FRAME) continue;
      const frame = decodeFramePayload(packet.payload);
      if (!frame) continue;
      const palette = palettes[frame.playpal] || palettes[0];
      const d = groundImage.data;
      for (let i = 0; i < NUM_PIXELS; i++) {
        const c = palette ? palette[frame.pixels[i]] : frame.pixels[i] * 0x010101;
        d[4 * i] = c >> 16; d[4 * i + 1] = (c >> 8) & 255; d[4 * i + 2] = c & 255; d[4 * i + 3] = 255;
      }
      groundCtx.putImageData(groundImage, 0, 0);
      link.rxFrames++; link.rxTimes.push(performance.now());
      link.lastPlaypal = frame.playpal;
    }
    if (link.tx.pos >= link.tx.bytes.length) frameDone();
  }
  link.realtime = 1;
}

// ---------------------------------------------------------------- uplink

function sampleKeys() {
  if (!running) return;
  const sample = keystroke([...uplink.held]);
  const idle = sample.every((b) => b === 0);
  const now = performance.now();
  if (!idle) uplink.lastKeyAt = now;
  const mode = ui.batch.value;
  if (mode === 'rec') {
    // app.py: a recording starts with the first key and ends 2 s after the last.
    if (!uplink.recording && idle) return;
    uplink.recording = true;
    uplink.samples.push(sample);
    if (now - uplink.lastKeyAt >= 2000) { sendBatch(); uplink.recording = false; }
    return;
  }
  if (idle && !uplink.samples.length && !uplink.recording) return;
  uplink.recording = !idle || uplink.samples.some((s) => s.some((b) => b));
  uplink.samples.push(sample);
  if (uplink.samples.length >= Number(mode)) {
    sendBatch();
    if (idle) uplink.recording = false;
  }
}

function sendBatch() {
  const samples = uplink.samples.splice(0);
  const packets = keyboardPackets(samples, uplink.batch);
  const batch = uplink.batch;
  uplink.batch = (uplink.batch + 1) & 255;
  for (const packet of packets) {
    uplink.queue.push(packet);
    uplink.sent++;
    log(`↑ ${UPLINK_COMMANDS[packet[0]]} batch ${batch}: ${hex(packet)}`, 'up');
  }
  if (link?.path !== 'rf') deliverUplink();
}

// On the balloon: the TT&C hands commands to the OBC, which passes DOOM
// input to the payload (the repositories stub this hop; it is modelled here).
function deliverUplink() {
  if (!uplink.queue.length) return;
  trUntil = performance.now() + 160;
  for (const packet of uplink.queue.splice(0)) {
    const command = parseUplink(packet);
    uplink.delivered++;
    if (command.command === 'keyboard') {
      payloadKeys.queue.push(...command.keystrokes);
      payloadKeys.releaseAt = 0;
      log(`  OBC: keyboard batch ${command.batch} packet ${command.seq + 1}/${command.count}, ${command.keystrokes.length} keystrokes → payload`, 'ok');
    } else if (command.command === 'eof') {
      payloadKeys.eofPending = true;
      log(`  OBC: EOF batch ${command.batch}`, 'ok');
    }
  }
}

function replayKeys(now) {
  if (!doom?.running) return;
  if (now - (payloadKeys.last || 0) < KEY_SAMPLE_MS) return;
  payloadKeys.last = now;
  let want = null;
  if (payloadKeys.queue.length) {
    want = doomKeysFor(payloadKeys.queue.shift());
    payloadKeys.applied++;
  } else if (payloadKeys.eofPending) {
    // End of a batch: hold the last keys briefly in case the next batch is
    // already on its way, then release everything.
    if (!payloadKeys.releaseAt) payloadKeys.releaseAt = now + 120;
    if (now >= payloadKeys.releaseAt) { want = new Set(); payloadKeys.eofPending = false; payloadKeys.releaseAt = 0; }
  }
  if (!want) return;
  for (const key of payloadKeys.held) if (!want.has(key)) doom.key(false, key);
  for (const key of want) if (!payloadKeys.held.has(key)) doom.key(true, key);
  payloadKeys.held = want;
}

ui.ground.addEventListener('keydown', (e) => {
  if (CODE_TO_HID[e.code] == null && !modifierBit(e.code)) return;
  e.preventDefault();
  uplink.held.add(e.code);
  byId('ground-overlay').hidden = true;
});
ui.ground.addEventListener('keyup', (e) => { uplink.held.delete(e.code); e.preventDefault(); });
ui.ground.addEventListener('blur', () => uplink.held.clear());
ui.ground.addEventListener('pointerdown', () => ui.ground.focus());
setInterval(sampleKeys, KEY_SAMPLE_MS);

// ---------------------------------------------------------------- run

async function startDoom() {
  if (doom?.running) return;
  const overlay = byId('payload-overlay');
  overlay.hidden = false; overlay.textContent = 'Loading DOOM…';
  doom = new DoomSim(ui.payload, {
    onStatus: () => {},
    onExit: (reason) => { overlay.hidden = false; overlay.textContent = `DOOM stopped: ${reason}`; },
    onFrame: (mod, image) => {
      live.rgba = image.data;
      const ptr = mod._dg_index_ptr();
      live.indexed = mod.HEAPU8.slice(ptr, ptr + NUM_PIXELS);
      live.playpal = mod._dg_playpal_index();
      live.frames++;
    },
  });
  await doom.start([6 * 1024 * 1024]);
  overlay.hidden = true;
}

async function prepareSource() {
  const rec = RECORDINGS[ui.source.value];
  if (!rec) { await startDoom(); return; }
  doom?.stop();
  if (!recordings[ui.source.value]) {
    const overlay = byId('payload-overlay');
    overlay.hidden = false; overlay.textContent = `Loading ${rec.path.split('/').pop()}…`;
    recordings[ui.source.value] = await readBinary(rec.path);
    overlay.hidden = true;
  }
}

function syncControls() {
  const rec = RECORDINGS[ui.source.value];
  if (rec) { ui.format.value = rec.format; if (ui.path.value === 'uart') ui.path.value = 'rf'; }
  ui.format.disabled = !!rec;
  ui.path.querySelector('[value="uart"]').disabled = !!rec;
  const rf = ui.path.value === 'rf';
  for (const id of ['format-row', 'snr-row', 'cfo-row', 'spectrum-plot', 'symbols-plot']) byId(id).hidden = !rf;
  byId('snr-value').textContent = `${ui.snr.value} dB`;
  byId('cfo-value').textContent = `${ui.cfo.value} kHz`;
  if (link) { link.channel.snrDb = Number(ui.snr.value); link.channel.offsetHz = Number(ui.cfo.value) * 1e3; }
}

async function start() {
  syncControls();
  ui.source.disabled = true;
  try { await prepareSource(); } catch (error) { byId('payload-overlay').textContent = error.message; ui.source.disabled = false; return; }
  link = newLink();
  running = true;
  byId('btn-start').textContent = 'Stop link';
  ui.source.disabled = false;
  byId('ground-overlay').hidden = false;
  byId('ground-overlay').textContent = 'Click here, then play with WASD, arrows, F or Ctrl to fire, Space to use';
  setTimeout(() => { if (running) byId('ground-overlay').hidden = document.activeElement === ui.ground; }, 2500);
}
function stop() {
  running = false;
  byId('btn-start').textContent = 'Start link';
  setState(byId('link-state'), 'stopped');
}
byId('btn-start').addEventListener('click', () => (running ? stop() : start()));
for (const el of [ui.source, ui.path, ui.format]) el.addEventListener('change', async () => {
  syncControls();
  if (!running) return;
  if (el === ui.source) { try { await prepareSource(); } catch (error) { byId('payload-overlay').textContent = error.message; } }
  link = newLink();
});
for (const el of [ui.snr, ui.cfo]) el.addEventListener('input', syncControls);

// ---------------------------------------------------------------- plots

function cssColor(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

function drawSpectrum() {
  const canvas = byId('spectrum'), ctx = canvas.getContext('2d'), w = canvas.width, h = canvas.height;
  ctx.fillStyle = cssColor('--plot-bg'); ctx.fillRect(0, 0, w, h);
  const half = phy.sampleRate / 2, x = (f) => ((f + half) / (2 * half)) * w;
  ctx.strokeStyle = cssColor('--plot-grid'); ctx.lineWidth = 1;
  for (let f = -1e6; f <= 1e6; f += 0.5e6) { ctx.beginPath(); ctx.moveTo(x(f), 0); ctx.lineTo(x(f), h); ctx.stroke(); }
  // The flowgraph's 400 kHz low-pass and the four FSK tones.
  ctx.fillStyle = cssColor('--accent-dim'); ctx.fillRect(x(-400e3), 0, x(400e3) - x(-400e3), h);
  ctx.strokeStyle = cssColor('--warning'); ctx.setLineDash([3, 3]);
  for (const level of [-1, -1 / 3, 1 / 3, 1]) { const fx = x(level * phy.deviation + (link?.channel.offsetHz || 0)); ctx.beginPath(); ctx.moveTo(fx, 0); ctx.lineTo(fx, h); ctx.stroke(); }
  ctx.setLineDash([]);
  if (link?.lastIq && link.path === 'rf') {
    const db = spectrum(link.lastIq, 512);
    ctx.strokeStyle = cssColor('--accent-bright'); ctx.lineWidth = 1.4; ctx.beginPath();
    db.forEach((v, i) => { const px = (i / db.length) * w, py = h - ((v + 60) / 70) * h; i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); });
    ctx.stroke();
  }
  ctx.fillStyle = cssColor('--text-dim'); ctx.font = '10px JetBrains Mono, monospace';
  ctx.fillText(`${fmtHz(phy.centerFreq - half)}`, 4, h - 4);
  ctx.fillText(`${fmtHz(phy.centerFreq)}`, w / 2 - 28, h - 4);
  ctx.fillText(`${fmtHz(phy.centerFreq + half)}`, w - 72, h - 4);
}

function drawSymbols() {
  const canvas = byId('symbols'), ctx = canvas.getContext('2d'), w = canvas.width, h = canvas.height;
  ctx.fillStyle = cssColor('--plot-bg'); ctx.fillRect(0, 0, w, h);
  const y = (v) => h / 2 - (v / 1.6) * (h / 2);
  ctx.strokeStyle = cssColor('--plot-grid');
  for (const v of [-1, -1 / 3, 1 / 3, 1]) { ctx.beginPath(); ctx.moveTo(0, y(v)); ctx.lineTo(w, y(v)); ctx.stroke(); }
  if (!link || link.path !== 'rf') {
    ctx.fillStyle = cssColor('--text-dim'); ctx.font = '11px Inter, sans-serif';
    ctx.fillText('UART carries bytes directly: no modulation.', 10, h / 2 + 4);
    return;
  }
  ctx.strokeStyle = cssColor('--warning'); ctx.setLineDash([4, 3]);
  for (const t of link.receiver.thr) { ctx.beginPath(); ctx.moveTo(0, y(t)); ctx.lineTo(w, y(t)); ctx.stroke(); }
  ctx.setLineDash([]);
  ctx.fillStyle = cssColor('--accent-bright');
  const r = link.recent, n = Math.min(r.length, 1200);
  for (let i = 0; i < n; i++) ctx.fillRect((i / n) * w, y(r[r.length - n + i]) - 1, 1.6, 1.6);
}

// ---------------------------------------------------------------- frame loop

let last = performance.now();
function tick(now) {
  const dt = Math.min(100, now - last);
  last = now;
  if (running && link) {
    if (link.path === 'rf') rfStep(dt); else uartStep(dt);
    replayKeys(now);
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

setInterval(() => {
  drawSpectrum(); drawSymbols();
  const tr = byId('tr-state');
  const rxWindow = performance.now() < trUntil;
  setState(tr, running && link?.path === 'rf' ? (rxWindow ? 'RX' : 'TX') : 'idle', running ? 'on' : '');
  document.querySelectorAll('[data-tr]').forEach((el) => {
    const active = running && link?.path === 'rf' && (el.dataset.tr === 'tx' ? !rxWindow : rxWindow);
    el.classList.toggle('active', active); el.classList.toggle('idle', running && link?.path === 'rf' && !active);
  });
  document.querySelectorAll('.flow').forEach((dot) => { dot.style.display = running ? '' : 'none'; });
  if (!link) {
    stats(byId('tx-stats'), [['Frames sent', '0'], ['Link', 'stopped']]);
    return;
  }
  const rf = link.path === 'rf';
  const bitrate = rf ? phy.symbolRate * 2 : UART_BYTES_PER_S * 8;
  const frameLen = link.tx?.bytes.length || (rf ? frameBytes(link.format) + 4 : link.lastRle || 0);
  const airtime = frameLen ? (frameLen * 8) / bitrate : 0;
  const recent = link.rxTimes.filter((t) => performance.now() - t < 3000);
  link.rxTimes = recent;
  setState(byId('tx-state'), running ? (link.tx ? 'sending' : 'waiting for a frame') : 'idle', running && link.tx ? 'on' : '');
  setState(byId('link-state'), running ? (rf ? `${fmtRate(bitrate)} 4-FSK` : 'UART 115200 8N1') : 'stopped', running ? 'on' : '');
  setState(byId('rx-state'), link.rxFrames ? `${link.rxFrames} frames` : 'waiting', link.rxFrames ? 'on' : '');
  stats(byId('tx-stats'), [
    ['Frames sent', String(link.sentFrames)],
    ['Bytes per frame', frameLen ? frameLen.toLocaleString() : '—'],
    [rf ? 'Air time per frame' : 'Wire time per frame', airtime ? `${(airtime * 1000).toFixed(0)} ms` : '—'],
    rf ? ['Sync-word scrub', link.rec ? 'recorded frames' : `${link.lastFix} symbols nudged`] : ['RLE packet', live.indexed ? `PLAYPAL ${live.playpal}, ${(NUM_PIXELS / Math.max(1, (link.lastRle || NUM_PIXELS))).toFixed(1)}× smaller` : '—'],
  ]);
  const rx = link.receiver.stats, ps = link.parser.stats;
  stats(byId('link-stats'), rf ? [
    ['Symbol rate', `${(phy.symbolRate / 1e3).toFixed(0)} ksym/s × 2 bits`],
    ['Real time', `${Math.round((link.realtime ?? 1) * 100)}%`],
    ['Sync words found', `${rx.headers} (${rx.cleanHeaders} clean)`],
    ['Symbol errors, last frame', link.symErrors ? `${link.symErrors.errors} / ${link.symErrors.total.toLocaleString()}` : '—'],
  ] : [
    ['Line rate', '115200 baud, 11.5 kB/s'],
    ['Packets', String(ps.packets)],
    ['CRC errors', String(ps.crcErrors)],
    ['Bad lengths', String(ps.badLength)],
  ]);
  stats(byId('rx-stats'), [
    ['Frames received', String(link.rxFrames)],
    ['Frame rate', `${(recent.length / 3).toFixed(1)} fps`],
    rf ? ['Last header', rx.lastHeader] : ['Palette', link.lastPlaypal != null ? `PLAYPAL ${link.lastPlaypal} (palettes.hex)` : '—'],
    ['Uplink packets', `${uplink.sent} sent, ${uplink.delivered} on board`],
  ]);
}, 250);

// ---------------------------------------------------------------- system diagram

const LAYOUT = {
  nrf: [30, 70], obc: [250, 70], ttc: [470, 70], pico: [30, 255], eps: [250, 335], sdr: [775, 70], gs: [775, 255],
};
const BW = 165, BH = 78;
// [from, to, path, label x, label y, link kind when two links join the same blocks]
const WIRES = [
  ['nrf', 'obc', 'M195,104 H250', 222, 98], ['obc', 'ttc', 'M415,104 H470', 442, 98], ['nrf', 'pico', 'M95,148 V255', 112, 205],
  ['eps', 'obc', 'M300,335 V148', 300, 236, 'power'], ['eps', 'obc', 'M365,335 V148', 365, 266, 'bus'],
  ['eps', 'nrf', 'M250,377 H165 V148', 165, 300], ['eps', 'ttc', 'M415,377 H552 V148', 552, 300],
  ['ttc', 'sdr', 'M635,98 H775', 705, 90], ['gs', 'ttc', 'M775,300 H612 V148', 694, 292], ['sdr', 'gs', 'M857,148 V255', 880, 205],
];

function renderSystem() {
  const parts = [];
  parts.push('<rect class="segment" x="14" y="26" width="655" height="430" rx="12"/><text class="segment-label" x="30" y="48">Flight segment · balloon gondola</text>');
  parts.push('<rect class="segment" x="745" y="26" width="245" height="430" rx="12"/><text class="segment-label" x="761" y="48">Ground segment</text>');
  for (const [from, to, d, lx, ly, kindHint] of WIRES) {
    const l = LINKS.find((k) => k.from === from && k.to === to && (!kindHint || k.kind === kindHint));
    if (!l) continue;
    parts.push(`<path class="wire ${l.kind}${l.planned ? ' planned' : ''}" d="${d}"><title>${html(l.note)}</title></path>`);
    parts.push(`<text class="wire-label" x="${lx}" y="${ly}" text-anchor="middle">${html(l.label)}</text>`);
    if (l.kind === 'rf' || l.kind === 'data') parts.push(`<circle class="flow" r="3.5" style="display:none"><animateMotion dur="${l.kind === 'rf' ? 0.9 : 1.6}s" repeatCount="indefinite" path="${d}"/></circle>`);
  }
  for (const b of BLOCKS) {
    const [x, y] = LAYOUT[b.id];
    parts.push(`<g class="blk" data-block="${b.id}" tabindex="0" role="button" aria-label="${html(`${b.title}, ${b.subtitle}`)}">
      <rect class="box" x="${x}" y="${y}" width="${BW}" height="${BH}" rx="9"/>
      <text class="t" x="${x + 12}" y="${y + 24}">${html(b.title)}</text>
      <text class="s" x="${x + 12}" y="${y + 42}">${html(b.subtitle)}</text>
      <text class="r" x="${x + 12}" y="${y + 62}">${html(b.repo || b.hw)}</text></g>`);
  }
  byId('system-diagram').innerHTML = `<svg viewBox="0 0 1000 470" role="img" aria-label="DOOM balloon system diagram">${parts.join('')}</svg>
    <div class="legend"><span><i style="border-color:var(--accent)"></i>RF</span><span><i style="border-color:var(--violet)"></i>video data</span><span><i style="border-color:var(--info)"></i>bus</span><span><i style="border-color:var(--warning)"></i>power</span><span><i style="border-color:var(--text-dim);border-top-style:dashed"></i>planned</span></div>`;
  for (const g of document.querySelectorAll('.blk')) {
    g.addEventListener('click', () => showBlock(g.dataset.block));
    g.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); showBlock(g.dataset.block); } });
  }
  showBlock('obc');
}

const BLOCK_SOURCES = {
  nrf: 'uvsd/uvsd-nrf-doom/nrfdoom/source', obc: OBC_FILES.main, pico: 'uvsd/uvsd-pico-bridge/spi_connection/spi_connection.c',
  gs: 'uvsd/uvsd-doom-gs/ground_station/messages.py', sdr: 'uvsd/uvsd-doom-gnu-radio/view_doom_zmq.py',
};
function showBlock(id) {
  const b = BLOCKS.find((x) => x.id === id);
  document.querySelectorAll('.blk').forEach((g) => g.classList.toggle('selected', g.dataset.block === id));
  const links = LINKS.filter((l) => l.from === id || l.to === id);
  const repos = [b.repo, b.hw].filter(Boolean);
  const source = BLOCK_SOURCES[id];
  byId('block-detail').innerHTML = `<div class="kicker">${html(b.segment === 'flight' ? 'Flight segment' : 'Ground segment')}</div>
    <h3>${html(b.title)}</h3><div class="mono dim">${html(b.subtitle)}</div>
    <p>${html(b.does)}</p>
    <ul>${b.parts.map((p) => `<li>${html(p)}</li>`).join('')}</ul>
    <p class="status">${html(b.status)}</p>
    <div class="kicker">Links</div>
    <ul>${links.map((l) => `<li><b>${html(l.label)}</b> ${html(l.from === id ? `to ${BLOCKS.find((x) => x.id === l.to).title}` : `from ${BLOCKS.find((x) => x.id === l.from).title}`)}${l.planned ? ' <span class="dim">(planned)</span>' : ''}: ${html(l.note)}</li>`).join('')}</ul>
    <div class="meta">${repos.map((r) => `<a class="tag" href="${GITHUB}/${r}" target="_blank" rel="noopener">${html(r)}</a>`).join('')}
    ${source && !/\/source$/.test(source) ? `<a class="tag" href="${ideLink(source)}">open in IDE</a>` : ''}</div>`;
}

// ---------------------------------------------------------------- TX / RX setups

// detail is trusted markup built here; tr marks the TX or RX chain, off a disabled block.
const stage = (title, detail, { tr = '', off = false } = {}) =>
  `<div class="stage${off ? ' off' : ''}"${tr ? ` data-tr="${tr}"` : ''}><b>${html(title)}</b><small>${detail}</small></div>`;
const chain = (stages) => `<div class="chain">${stages.join('<div class="arrow" aria-hidden="true">→</div>')}</div>`;

function renderTtc() {
  const tx = [
    stage('OBC', 'SPI commands and data<br>CC1201 GPIO0 IRQ back', { tr: 'tx' }),
    stage('CC1201', 'sub-GHz transceiver<br>40 MHz crystal', { tr: 'tx' }),
    stage('PE4259 · U7', 'TX position<br>GPIO3 high', { tr: 'tx' }),
    stage('Attenuator', 'resistor pad', { tr: 'tx' }),
    stage('GRF5511 PA', 'enabled by GPIO3', { tr: 'tx' }),
    stage('Low-pass', 'LC harmonic filter', { tr: 'tx' }),
    stage('PE4259 · U8', 'TX position', { tr: 'tx' }),
    stage('MCX antenna', '915 MHz ISM<br>U.FL test ports', { tr: 'tx' }),
  ];
  const rx = [
    stage('MCX antenna', 'uplink from the ground', { tr: 'rx' }),
    stage('PE4259 · U8', 'RX position', { tr: 'rx' }),
    stage('B39921 SAW', 'band filter', { tr: 'rx' }),
    stage('TQP3M9036 LNA', 'enabled by GPIO2<br>via NX138', { tr: 'rx' }),
    stage('PE4259 · U7', 'RX position<br>GPIO3 low', { tr: 'rx' }),
    stage('CC1201', 'packet received<br>GPIO0 interrupt', { tr: 'rx' }),
    stage('OBC handle_command', 'Core/Src/command.c<br>(stub)', { tr: 'rx' }),
  ];
  byId('ttc-chain').innerHTML = `<div class="chain-row"><span>Transmit</span>${chain(tx)}</div><div class="chain-row"><span>Receive</span>${chain(rx)}</div>
    <p class="note">One CC1201 drives both chains. GPIO3 throws both RF switches and enables the PA; GPIO2 powers the LNA. While the link runs, the downlink holds the board in TX and queued uplink commands go up between frames. Parts from the uvsd-doom-ttc-pcb schematics; the GPS (MAX-M8C on UART/I2C) shares the board.</p>`;
}

function grcStage(b, vars) {
  const p = b.parameters, ev = (e) => evaluate(e, vars);
  switch (b.id) {
    case 'rtlsdr_source': return stage('RTL-SDR source', `${fmtHz(ev(p.freq0))}<br>${(ev(p.sample_rate) / 1e6).toFixed(2)} Msps<br>gain ${p.gain0} dB`);
    case 'freq_xlating_fir_filter_xxx': {
      const fs = ev(p.samp_rate), cf = ev(p.center_freq);
      let shift = ((cf % fs) + fs) % fs; if (shift > fs / 2) shift -= fs;
      return stage('Freq. xlating FIR', `center_freq ${p.center_freq}<br>shift wraps to ${fmtHz(Math.round(shift))} at ${fmtHz(fs)}`);
    }
    case 'low_pass_filter': return stage(`Low-pass (${p.type?.includes('ccf') ? 'complex' : 'real'})`, `cutoff ${fmtHz(ev(p.cutoff_freq))}<br>transition ${fmtHz(ev(p.width))}`);
    case 'analog_quadrature_demod_cf': return stage('Quadrature demod', `gain ${ev(p.gain).toFixed(3)}<br>${html(p.gain)}`);
    case 'rational_resampler_xxx': return stage('Rational resampler', `${p.interp} / ${p.decim}`);
    case 'digital_symbol_sync_xx': return stage('Symbol sync', `${ev(p.sps)} sps, loop bw ${p.loop_bw}<br>${html(String(p.resamp_type).replace('digital.', ''))}`);
    case 'zeromq_pub_sink': return stage('ZMQ PUB sink', `${html(p.address)}<br>float symbols`);
    case 'qtgui_sink_x': return stage('Qt GUI sink', 'spectrum, waterfall, time');
    default: return stage(b.id, '');
  }
}

async function renderSetups() {
  renderTtc();
  try {
    const graph = parseGrc(await readText(GRC_PATH));
    const vars = graph.variables;
    Object.assign(phy, {
      sampleRate: evaluate(vars.samp_rate, vars) || phy.sampleRate, symbolRate: evaluate(vars.sym_rate, vars) || phy.symbolRate,
      deviation: evaluate(vars.fsk_deviation_hz, vars) || phy.deviation, centerFreq: evaluate(vars.center_freq, vars) || phy.centerFreq,
    });
    if (link) link = newLink();
    byId('grc-meta').textContent = `${fmtHz(phy.centerFreq)} · ${(phy.sampleRate / 1e6).toFixed(1)} Msps · ${phy.symbolRate / 1e3} ksym/s · ±${fmtHz(phy.deviation)}`;
    byId('spectrum-caption').textContent = `Spectrum at the receiver, ${fmtHz(phy.centerFreq)} ± ${fmtHz(phy.sampleRate / 2)}: tones at ±${fmtHz(phy.deviation / 3)} and ±${fmtHz(phy.deviation)}, shaded to the 400 kHz low-pass`;
    const rows = signalChains(graph).map(({ main, taps }) => {
      const stages = main.map((b) => grcStage(b, vars));
      stages.push(stage('view_doom_zmq.py', 'SUB tcp://127.0.0.1:5555<br>auto slicer, AA BB CC DD<br>160×100 · 4 bpp'));
      return `<div class="chain-row"><span>Enabled</span>${chain(stages)}</div>${taps.length ? `<p class="note">Taps: ${taps.map((t) => `${html(t.block.id)} after ${html(t.from)}`).join(', ')}.</p>` : ''}`;
    });
    const mod = graph.blocks.find((b) => b.id === 'epy_block' && /deviation/.test(Object.keys(b.parameters).join(' ')));
    const benchTx = mod ? `<div class="chain-row"><span>Bench TX</span>${chain([
      stage('doom_raw_sender.py', '--file doom_raw.bin<br>frames back to back', { off: true }),
      stage('TCP', `127.0.0.1:${html(mod.parameters.port)}`, { off: true }),
      stage('Raw 4-GFSK Mod', `${fmtHz(evaluate(mod.parameters.deviation, vars))} deviation<br>${evaluate(mod.parameters.symbol_rate, vars) / 1e3} ksym/s, gray ${html(mod.parameters.gray)}`, { off: true }),
      stage('Throttle', 'into the complex low-pass', { off: true }),
    ])}</div><p class="note">Disabled in the committed flowgraph (${mod.state}); enabling it in place of the RTL-SDR runs the whole link in software, which is what the live demo above reproduces.</p>` : '';
    byId('grc-chain').innerHTML = rows.join('') + benchTx +
      `<p class="note">Read from <a href="${ideLink(GRC_PATH)}">${GRC_PATH}</a> (${graph.blocks.length} blocks, ${graph.connections.length} connections).</p>`;
  } catch (error) {
    byId('grc-chain').innerHTML = `<p class="note">${html(error.message)}</p>`;
  }
  byId('bench-chain').innerHTML = `<div class="chain-row"><span>UART</span>${chain([
    stage('nRF5340 DOOM', 'DG_DrawFrame → n_frame_uart.c'),
    stage('Frame packet', 'AA 55 · 02 · LEN u32 LE<br>PLAYPAL · RLE · CRC-16'),
    stage('UARTE0', '115200 8N1<br>~11.5 kB/s'),
    stage('J-Link VCOM', 'USB serial on the DK'),
    stage('serial_rx.py', 'uvsd-doom-gs PR #10<br>CRC check, RLE decode'),
    stage('Ground display', 'palettes.hex · PLAYPAL<br>320×200 at 1.2× height'),
  ])}</div><div class="chain-row"><span>Pico</span>${chain([
    stage('nRF5340', 'SPI master (planned)'),
    stage('SPI0 slave', 'GPIO16 RX · 17 CSn<br>18 SCK · 19 TX, 1 MHz'),
    stage('Pico 2 · RP2350', 'spi_connection.c<br>sends sample_frame.jpg'),
    stage('USB CDC', 'header line · 3072-byte chunks<br>\\n__IMAGE_EOF__\\n'),
    stage('usb_laptop', 'uv run usb &lt;port&gt;<br>→ frame_output.jpg'),
  ])}</div><p class="note">The UART path is what the live demo's “Payload packets” option runs: 115200 baud is the fastest rate that decoded cleanly on the DK's J-Link bridge, so full-colour frames arrive about every 2 s.</p>`;
}

// ---------------------------------------------------------------- OBC

async function renderObc() {
  let obc;
  try { obc = await readObc(readText); } catch (error) { byId('obc-tasks').innerHTML = `<tr><td>${html(error.message)}</td></tr>`; return; }
  byId('rtos-meta').textContent = `${obc.rtos.tickHz} Hz tick · ${obc.rtos.heapBytes.toLocaleString()} B heap`;
  byId('obc-tasks').innerHTML = `<tr><th>Task</th><th>Entry</th><th>Priority</th><th>Stack</th></tr>` +
    obc.tasks.map((t) => `<tr><td>${html(t.name)}<div class="dim mono">${html(t.api)}</div></td><td class="mono">${html(t.entry)}</td><td>${html(t.priority)}${t.level != null ? ` <span class="dim">(${t.level})</span>` : ''}</td><td class="num">${t.stackBytes ?? '?'} B</td></tr>`).join('') +
    `<tr><td colspan="4" class="dim">From <a href="${ideLink(OBC_FILES.main)}">Core/Src/main.c</a>. The telemetry and command task bodies are empty loops so far.</td></tr>`;
  byId('sensors-link').href = ideLink(OBC_FILES.sensors);
  byId('obc-telemetry').innerHTML = `<tr><th>Getter</th><th>Reads</th><th>Unit</th></tr>` +
    obc.telemetry.map((c) => `<tr><td class="mono">${html(c.fn)}()</td><td>${html(c.brief)}${c.vector ? ' <span class="dim">(x, y, z)</span>' : ''}</td><td class="num">${html(c.unit)}</td></tr>`).join('') +
    `<tr><td colspan="3" class="dim">${obc.telemetry.length} channels; every getter in Core/Src/telemetry_sensors.c still returns 0. The EPS board feeds the current, voltage and regulator temperatures through two TLA2528 I2C ADCs.</td></tr>`;
  byId('mcu-name').textContent = `${obc.mcu} · ${obc.ips.length} IPs enabled`;
  byId('obc-pins').innerHTML = `<tr><th>Peripheral</th><th>Pins</th></tr>` +
    obc.peripherals.map((p) => `<tr><td class="mono">${html(p.name)}</td><td class="mono">${html(p.pins.join(' · '))}</td></tr>`).join('') +
    `<tr><td colspan="2" class="dim">Reserved in uvsd-doom-obc.ioc. Enabled IPs: ${html(obc.ips.join(', '))}; the buses have no init code yet. Board connectors: J7 PA12/PA11 parachute release, PD7 antenna release; J8 PD3/PD4 switches.</td></tr>`;
}

function renderFlight() {
  const root = byId('flight');
  root.innerHTML = `<canvas class="flight-plot" id="flight-plot" width="560" height="190"></canvas>
    <div class="flight-controls"><button class="btn" id="btn-flight" type="button">Fly</button>
    <label>Ascent <input id="ascent" type="range" min="3" max="9" step="0.5" value="5"><output id="ascent-value">5 m/s</output></label>
    <span class="mono dim" id="flight-readout"></span></div>
    <p class="note">PR #33 (draft) fires the burnwire on <code>${html(BURNWIRE.pin)}</code> from the ${html(BURNWIRE.rail)} at ${BURNWIRE.altitudeM.toLocaleString()} m or after ${BURNWIRE.timeS / 60} minutes, whichever comes first, or on the ground's Burn Wire command (0x06). The ascent is modelled; read_altimeter() is still a stub.</p>`;
  const plot = byId('flight-plot'), ctx = plot.getContext('2d');
  let t = 0, flying = false, fired = null, lastNow = 0;
  const ascent = () => Number(byId('ascent').value);
  const draw = () => {
    const w = plot.width, h = plot.height, tMax = 70 * 60, aMax = 30000;
    const x = (s) => 34 + (s / tMax) * (w - 44), y = (m) => h - 20 - (m / aMax) * (h - 30);
    ctx.fillStyle = cssColor('--plot-bg'); ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = cssColor('--plot-grid'); ctx.fillStyle = cssColor('--text-dim'); ctx.font = '10px JetBrains Mono, monospace';
    for (let m = 0; m <= aMax; m += 10000) { ctx.beginPath(); ctx.moveTo(34, y(m)); ctx.lineTo(w - 10, y(m)); ctx.stroke(); ctx.fillText(`${m / 1000}k`, 4, y(m) + 3); }
    for (let s = 0; s <= tMax; s += 600) ctx.fillText(`${s / 60}`, x(s) - 6, h - 6);
    ctx.strokeStyle = cssColor('--error'); ctx.setLineDash([4, 3]);
    ctx.beginPath(); ctx.moveTo(34, y(BURNWIRE.altitudeM)); ctx.lineTo(w - 10, y(BURNWIRE.altitudeM)); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x(BURNWIRE.timeS), 10); ctx.lineTo(x(BURNWIRE.timeS), h - 20); ctx.stroke(); ctx.setLineDash([]);
    const fireAt = Math.min(BURNWIRE.timeS, BURNWIRE.altitudeM / ascent());
    ctx.strokeStyle = cssColor('--accent-bright'); ctx.lineWidth = 2; ctx.beginPath();
    for (let s = 0; s <= Math.min(t, tMax); s += 20) {
      const alt = s <= fireAt ? s * ascent() : Math.max(0, fireAt * ascent() - (s - fireAt) * 12);
      s ? ctx.lineTo(x(s), y(alt)) : ctx.moveTo(x(s), y(alt));
    }
    ctx.stroke(); ctx.lineWidth = 1;
    const alt = t <= fireAt ? t * ascent() : Math.max(0, fireAt * ascent() - (t - fireAt) * 12);
    byId('flight-readout').textContent = `T+${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')} · ${Math.round(alt).toLocaleString()} m`;
    if (t >= fireAt && !fired) fired = fireAt === BURNWIRE.timeS && BURNWIRE.timeS * ascent() < BURNWIRE.altitudeM ? 'time limit' : 'altitude limit';
    setState(byId('burn-state'), fired ? `fired: ${fired}` : 'armed', fired ? 'bad' : '');
  };
  const step = (now) => {
    if (!flying) return;
    t += Math.min(0.1, (now - (lastNow || now)) / 1000) * 120; lastNow = now;
    if (t > 70 * 60) { flying = false; byId('btn-flight').textContent = 'Fly again'; }
    draw();
    requestAnimationFrame(step);
  };
  byId('btn-flight').addEventListener('click', () => {
    if (flying) { flying = false; byId('btn-flight').textContent = 'Fly'; return; }
    if (t > 70 * 60) { t = 0; fired = null; }
    flying = true; lastNow = 0; byId('btn-flight').textContent = 'Pause'; requestAnimationFrame(step);
  });
  byId('ascent').addEventListener('input', () => { byId('ascent-value').textContent = `${byId('ascent').value} m/s`; t = 0; fired = null; draw(); });
  draw();
}

// ---------------------------------------------------------------- repositories

async function renderRepos() {
  let manifest;
  try { manifest = JSON.parse(await readText('uvsd/repos.json')); } catch (error) { byId('repo-table').innerHTML = `<tr><td>${html(error.message)}</td></tr>`; return; }
  const pins = window.UVSD_SOURCES?.pins || {};
  const projects = [...new Set(manifest.repos.map((r) => r.project || 'Other'))];
  byId('repo-table').innerHTML = projects.map((project) => {
    const repos = manifest.repos.filter((r) => (r.project || 'Other') === project);
    return `<tr><th colspan="4" class="group">${html(project)} · ${repos.length}</th></tr>` + repos.map((r) => `<tr class="repo"><td><a href="${GITHUB}/${r.id}" target="_blank" rel="noopener">${html(r.id)}</a>${r.private ? ' <span class="tag">private</span>' : ''}</td>
      <td>${html(r.role)}</td><td>${html(r.lang)}</td>
      <td class="mono">${pins[r.id] ? `<a href="${GITHUB}/${r.id}/commit/${pins[r.id]}" target="_blank" rel="noopener">${pins[r.id].slice(0, 7)}</a>` : '—'}</td></tr>`).join('');
  }).join('');
}

// ---------------------------------------------------------------- start up

(async () => {
  syncControls();
  renderSystem();
  renderFlight();
  drawSpectrum(); drawSymbols();
  try { palettes = parsePalettes(await readText(PALETTE_PATH)); } catch { palettes = []; }
  await Promise.all([renderSetups(), renderObc(), renderRepos()]);
  document.body.dataset.ready = '1';
})();
