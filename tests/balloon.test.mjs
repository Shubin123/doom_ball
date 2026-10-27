// DOOM Balloon page: the wire formats against the UVic Satellite Design
// sources they were ported from, the modem against the GNU Radio recordings,
// the source readers against the submodules, and the page in headless Chrome.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { crc16, encodeFramePacket, FrameParser, decodeFramePayload, keystroke, keyboardPackets, parseUplink, doomKeysFor, parsePalettes, NUM_PIXELS } from '../ide/balloon/protocol.js';
import { FRAME_FORMATS, frameBytes, bytesToSymbols, symbolsToBytes, encodeTestFrame, decodeTestFrame, FskModulator, Channel, FskDemodulator, TestFrameReceiver, FSK_LEVELS } from '../ide/balloon/modem.js';
import { readObc } from '../ide/balloon/obc-source.js';
import { parseGrc, signalChains, evaluate } from '../ide/balloon/grc.js';
import { chrome, withStaticIde } from './chrome_ide.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const uvsd = (rel) => path.join(root, 'uvsd', rel);
const has = (rel) => fs.existsSync(uvsd(rel));
// A Git LFS pointer is a small text file; the real recordings are megabytes.
const lfsPulled = (rel) => has(rel) && fs.statSync(uvsd(rel)).size > 4096;
const uv = [process.env.UV, 'uv', path.join(os.homedir(), '.local/bin/uv')].filter(Boolean)
  .find((cmd) => spawnSync(cmd, ['--version']).status === 0);

// A real E1M1 frame (8-bit palette indices) from the DOOM WebAssembly build.
async function doomFrame() {
  const createDoomModule = createRequire(import.meta.url)(path.join(root, 'sim/doom.js'));
  let mod = null, rgba = null;
  mod = await createDoomModule({ noMainLoop: true, print() {}, printErr() {}, onFrame(ptr) { rgba = mod.HEAPU8.slice(ptr, ptr + NUM_PIXELS * 4); } });
  mod.FS.writeFile('/doom1.wad', fs.readFileSync(path.join(root, 'sim/doom1.wad')));
  mod._dg_set_zone_size(6 << 20);
  mod.callMain(['-iwad', '/doom1.wad', '-warp', '1']);
  for (let i = 0; i < 40; i++) mod._doomgeneric_Tick();
  const ptr = mod._dg_index_ptr();
  return { indexed: mod.HEAPU8.slice(ptr, ptr + NUM_PIXELS), playpal: mod._dg_playpal_index(), rgba };
}

test('frame packets: CRC-16/CCITT-FALSE, RLE and resync after garbage and corruption', async () => {
  assert.equal(crc16(new TextEncoder().encode('123456789')), 0x29b1);
  const { indexed, playpal } = await doomFrame();
  const packet = encodeFramePacket(indexed, playpal);
  assert.deepEqual([...packet.subarray(0, 3)], [0xaa, 0x55, 0x02]);
  assert.equal(new DataView(packet.buffer).getUint32(3, true), packet.length - 9);
  const corrupt = packet.slice(); corrupt[500] ^= 0x10;
  const parser = new FrameParser();
  const got = [...parser.push([0x13, 0xaa, 0x55, 0x02, 0xff, 0xff, 0xff, 0x7f]), ...parser.push(corrupt), ...parser.push(packet.subarray(0, 77)), ...parser.push(packet.subarray(77))];
  assert.equal(got.length, 1);
  assert.deepEqual(parser.stats, { packets: 1, crcErrors: 1, badLength: 1, bytes: 8 + corrupt.length + packet.length });
  const frame = decodeFramePayload(got[0].payload);
  assert.equal(frame.playpal, playpal);
  assert.deepEqual(frame.pixels, indexed);
});

test('keyboard uplink packets match the spec examples and parse back on the balloon', () => {
  // uvsd-doom-gs tests/test_messages.py: Shift+A then b, Ctrl+Shift+A+F+Up.
  assert.deepEqual(keystroke(['ShiftLeft', 'KeyA']), [0x02, 0x04, 0, 0]);
  assert.deepEqual(keystroke(['ControlLeft', 'ShiftRight', 'KeyA', 'KeyF', 'ArrowUp']), [0x03, 0x04, 0x09, 0x52]);
  const samples = [...Array(130)].map((_, i) => keystroke(i % 2 ? ['KeyW'] : ['KeyF', 'Space']));
  const packets = keyboardPackets([...samples, [0, 0, 0, 0], [0, 0, 0, 0]], 7);
  assert.deepEqual(packets.map((p) => p.length), [245, 245, 45, 2]);
  assert.deepEqual([...packets[3]], [0x04, 7]);
  const back = packets.map(parseUplink);
  assert.deepEqual(back.slice(0, 3).map((p) => [p.batch, p.seq, p.count]), [[7, 0, 3], [7, 1, 3], [7, 2, 3]]);
  assert.deepEqual(back.flatMap((p) => p.keystrokes || []), samples);
  assert.deepEqual([...doomKeysFor(keystroke(['KeyW', 'ControlLeft']))].sort(), [0xa3, 0xad]);
});

test('keyboard packets are byte-identical to uvsd-doom-gs messages.py', { skip: !uv || !has('uvsd-doom-gs/ground_station/messages.py') ? 'needs uv and the uvsd-doom-gs submodule' : false }, () => {
  const samples = [...Array(75)].map((_, i) => [i & 0x0f, 0x04 + (i % 26), i % 3 ? 0x2c : 0, i % 5 ? 0 : 0x52]);
  const script = `import json, sys
sys.path.insert(0, 'ground_station')
from messages import DOOMKeystroke, DOOMKeystrokeList
ks = DOOMKeystrokeList([DOOMKeystroke(m, (a, b, c)) for m, a, b, c in json.loads(sys.argv[1])])
ks.remove_trailing_idles()
print(json.dumps([p.hex() for p in ks.to_packets(200)]))`;
  const out = execFileSync(uv, ['run', '--frozen', '--quiet', 'python', '-c', script, JSON.stringify(samples)], { cwd: uvsd('uvsd-doom-gs'), encoding: 'utf8', env: { ...process.env, QT_QPA_PLATFORM: 'offscreen' } });
  assert.deepEqual(keyboardPackets(samples, 200).map((p) => Buffer.from(p).toString('hex')), JSON.parse(out));
});

test('frame packets decode with uvsd-doom-gs serial_rx.py (PR #10)', { skip: !uv || !has('uvsd-doom-gs/.git') ? 'needs uv and the uvsd-doom-gs submodule' : false }, async (t) => {
  const show = spawnSync('git', ['show', 'origin/add-doom-video:ground_station/serial_rx.py'], { cwd: uvsd('uvsd-doom-gs'), encoding: 'utf8' });
  if (show.status !== 0) return t.skip('branch add-doom-video is not fetched');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'balloon-serial-rx-'));
  try {
    fs.writeFileSync(path.join(dir, 'serial_rx.py'), show.stdout);
    const { indexed, playpal } = await doomFrame();
    const packet = encodeFramePacket(indexed, playpal);
    fs.writeFileSync(path.join(dir, 'stream.bin'), Buffer.concat([Buffer.from([1, 2, 0xaa]), packet, packet]));
    const script = `import hashlib, sys
sys.path.insert(0, sys.argv[1])
import serial_rx
data = open(sys.argv[2], 'rb').read(); pos = 0
def read_exact(n):
    global pos
    chunk = data[pos:pos + n]; pos += n
    return chunk
for _ in range(2):
    ptype, payload = serial_rx.read_packet(read_exact)
    pixels = serial_rx.decode_rle(payload[1:], serial_rx.NUM_PIXELS)
    print(ptype, payload[0], len(pixels), hashlib.sha256(pixels).hexdigest())`;
    const out = execFileSync(uv, ['run', '--frozen', '--quiet', '--with', 'pyserial', 'python', '-c', script, dir, path.join(dir, 'stream.bin')], { cwd: uvsd('uvsd-doom-gs'), encoding: 'utf8', env: { ...process.env, QT_QPA_PLATFORM: 'offscreen' } });
    const sha = (await import('node:crypto')).createHash('sha256').update(indexed).digest('hex');
    assert.deepEqual(out.trim().split('\n'), [`2 ${playpal} ${NUM_PIXELS} ${sha}`, `2 ${playpal} ${NUM_PIXELS} ${sha}`]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('palettes.hex: 14 PLAYPAL palettes of 256 colours', { skip: !has('uvsd-doom-gs/assets/palettes.hex') }, () => {
  const palettes = parsePalettes(fs.readFileSync(uvsd('uvsd-doom-gs/assets/palettes.hex'), 'utf8'));
  assert.equal(palettes.length, 14);
  assert.ok(palettes.every((p) => p.length === 256));
  assert.deepEqual(palettes[0].slice(0, 3), [0x000000, 0x1f170b, 0x170f07]);
});

test('4-FSK modem reproduces and decodes the GNU Radio IQ recording', { skip: !lfsPulled('uvsd-doom-gnu-radio/doom_gameplay.cfile') ? 'git lfs pull in uvsd/uvsd-doom-gnu-radio' : false }, () => {
  const buf = fs.readFileSync(uvsd('uvsd-doom-gnu-radio/doom_gameplay.cfile'));
  const iq = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
  const demod = new FskDemodulator(), rx = new TestFrameReceiver(FRAME_FORMATS.grey), frames = [];
  for (let i = 0; i < iq.length; i += 1 << 20) frames.push(...rx.push(demod.demodulate(iq.subarray(i, Math.min(iq.length, i + (1 << 20))))));
  assert.equal(frames.length, 120);
  assert.equal(rx.stats.cleanHeaders, 120);
  // gen_doom_gameplay.py modulated frame 0 from phase 0 with the same rule.
  const sent = new FskModulator().modulate(bytesToSymbols(Uint8Array.from([0xaa, 0xbb, 0xcc, 0xdd, ...symbolsToBytes(frames[0])])));
  let worst = 0;
  for (let i = 0; i < sent.length; i++) worst = Math.max(worst, Math.abs(sent[i] - iq[i]));
  assert.ok(worst < 1e-5, `IQ differs by ${worst}`);
});

for (const [file, format, count] of [['doom_raw.bin', 'grey', 240], ['colour gameplay/doom_raw_rgb.bin', 'colour', 160]]) {
  test(`recorded gameplay ${file}: ${count} frames, all received through a 20 dB channel`, { skip: !lfsPulled(`uvsd-doom-gnu-radio/${file}`) ? 'git lfs pull in uvsd/uvsd-doom-gnu-radio' : false }, () => {
    const data = fs.readFileSync(uvsd(`uvsd-doom-gnu-radio/${file}`));
    const size = frameBytes(FRAME_FORMATS[format]) + 4;
    assert.equal(data.length, count * size);
    const clean = new TestFrameReceiver(FRAME_FORMATS[format]);
    assert.equal(clean.push(Float32Array.from(bytesToSymbols(data), (s) => FSK_LEVELS[s])).length, count);
    const mod = new FskModulator(), channel = new Channel(), demod = new FskDemodulator(), rx = new TestFrameReceiver(FRAME_FORMATS[format]);
    channel.snrDb = 20; channel.offsetHz = 4e3;
    let received = 0, errors = 0;
    for (let k = 0; k < 6; k++) for (const symbols of rx.push(demod.demodulate(channel.apply(mod.modulate(bytesToSymbols(data.subarray(k * size, (k + 1) * size))))))) {
      const ref = bytesToSymbols(data.subarray(received * size + 4, (received + 1) * size));
      for (let i = 0; i < ref.length; i++) errors += ref[i] !== symbols[i];
      received++;
    }
    assert.ok(received >= 5, `${received} of 6 frames`);
    assert.ok(errors / (received * (size - 4) * 4) < 5e-3, `symbol error rate ${errors / (received * (size - 4) * 4)}`);
  });
}

test('live frames: scrubbed of sync words, decoded back to the picture', async () => {
  const { rgba } = await doomFrame();
  for (const format of Object.values(FRAME_FORMATS)) {
    const { frame } = encodeTestFrame(rgba, format);
    const rx = new TestFrameReceiver(format);
    const frames = rx.push(Float32Array.from(bytesToSymbols(Uint8Array.from([...frame, ...frame])), (s) => FSK_LEVELS[s]));
    assert.equal(frames.length, 2, format.label);
    const picture = decodeTestFrame(frames[0], format);
    let diff = 0;
    for (let i = 0; i < picture.length; i += 4) diff += Math.abs(picture[i] - rgba[i]) + Math.abs(picture[i + 1] - rgba[i + 1]) + Math.abs(picture[i + 2] - rgba[i + 2]);
    assert.ok(diff / (NUM_PIXELS * 3) < 48, `${format.label}: mean error ${diff / (NUM_PIXELS * 3)}`);
  }
});

test('OBC tasks, telemetry and pins are read from uvsd-doom-obc', { skip: !has('uvsd-doom-obc/Core/Src/main.c') }, async () => {
  const obc = await readObc(async (rel) => fs.readFileSync(path.join(root, rel), 'utf8'));
  assert.equal(obc.mcu, 'STM32H733VGTx');
  assert.deepEqual(obc.tasks.map((t) => [t.name, t.entry, t.stackBytes]), [['defaultTask', 'StartDefaultTask', 512], ['Handle Telemetry', 'handle_telemetry', 512], ['Handle Command', 'handle_command', 512]]);
  assert.deepEqual(obc.rtos, { tickHz: 1000, heapBytes: 15360, maxPriorities: 56, minimalStack: 128 });
  assert.equal(obc.telemetry.length, 16);
  assert.deepEqual(obc.telemetry.find((c) => c.fn === 'read_altimeter'), { fn: 'read_altimeter', brief: 'current altitude', unit: 'm', vector: false });
  assert.deepEqual(obc.peripherals.find((p) => p.name === 'SDMMC1').pins, ['PC8 D0', 'PC9 D1', 'PC10 D2', 'PC11 D3', 'PC12 CK', 'PD2 CMD']);
});

test('DOOMflow.grc: variables and the enabled receive chain', { skip: !has('uvsd-doom-gnu-radio/DOOMflow.grc') }, () => {
  const graph = parseGrc(fs.readFileSync(uvsd('uvsd-doom-gnu-radio/DOOMflow.grc'), 'utf8'));
  assert.equal(evaluate('samp_rate/sym_rate', graph.variables), 4);
  assert.equal(evaluate(graph.variables.center_freq, graph.variables), 915e6);
  const [chain] = signalChains(graph);
  assert.deepEqual(chain.main.map((b) => b.id), ['rtlsdr_source', 'freq_xlating_fir_filter_xxx', 'low_pass_filter', 'analog_quadrature_demod_cf', 'low_pass_filter', 'rational_resampler_xxx', 'digital_symbol_sync_xx', 'zeromq_pub_sink']);
  assert.equal(chain.main.at(-1).parameters.address, 'tcp://127.0.0.1:5555');
});

test('ide/balloon.js and ide/uvsd-sources.js are up to date', () => {
  const before = ['ide/forge.js', 'ide/balloon.js', 'ide/uvsd-sources.js'].map((f) => fs.readFileSync(path.join(root, f), 'utf8'));
  execFileSync(process.execPath, ['tools/bundle_ide.mjs'], { cwd: root });
  const after = ['ide/forge.js', 'ide/balloon.js', 'ide/uvsd-sources.js'].map((f) => fs.readFileSync(path.join(root, f), 'utf8'));
  assert.deepEqual(after, before, 'run node tools/bundle_ide.mjs');
});

test('balloon page: DOOM over the RF and UART links, keys up the uplink', { skip: !chrome }, async () => {
  await withStaticIde(async ({ send, evaluate: page, waitFor, errors, requests }) => {
    const external = requests.filter((url) => !/^(http:\/\/127\.0\.0\.1:\d+\/|data:|blob:)/.test(url));
    assert.deepEqual(external, [], 'nothing is loaded from other hosts');
    assert.equal(await page(`document.querySelectorAll('#obc-tasks tr').length`), 5);
    assert.match(await page(`document.querySelector('#grc-meta').textContent`), /915 MHz · 2\.5 Msps · 625 ksym\/s/);
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'uvsd/repos.json'), 'utf8'));
    assert.equal(await page(`document.querySelectorAll('#repo-table tr.repo').length`), manifest.repos.length);
    await page(`document.querySelector('#btn-start').click()`);
    await waitFor(`/^\\d+ frames/.test(document.querySelector('#rx-state').textContent) && parseInt(document.querySelector('#rx-state').textContent) >= 5`, 60000);
    await page(`document.querySelector('#ground-screen').focus()`);
    await send('Input.dispatchKeyEvent', { type: 'keyDown', code: 'KeyW', key: 'w', windowsVirtualKeyCode: 87 });
    await new Promise((resolve) => setTimeout(resolve, 700));
    await send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'KeyW', key: 'w', windowsVirtualKeyCode: 87 });
    await waitFor(`document.querySelector('#uplink-log').textContent.includes('OBC: keyboard batch 0') && document.querySelector('#uplink-log').textContent.includes('OBC: EOF batch')`, 15000);
    assert.match(await page(`document.querySelector('#uplink-log').textContent`), /↑ DOOM keyboard batch 0: 02 00 00 01 06 00 1a 00 00/);
    await page(`(() => { const p = document.querySelector('#path'); p.value = 'uart'; p.dispatchEvent(new Event('change')); return 1; })()`);
    await waitFor(`[...document.querySelectorAll('#link-stats div')].some((d) => /^Packets[1-9]/.test(d.textContent))`, 30000);
    assert.equal(await page(`[...document.querySelectorAll('#link-stats div')].find((d) => d.textContent.startsWith('CRC errors')).textContent`), 'CRC errors0');
    await page(`(() => { const s = document.querySelector('#source'); s.value = 'rec-colour'; s.dispatchEvent(new Event('change')); return 1; })()`);
    await waitFor(`document.querySelector('#path').value === 'rf' && [...document.querySelectorAll('#link-stats div')].some((d) => /^Sync words found[1-9]/.test(d.textContent))`, 30000);
    assert.deepEqual(errors, []);
  }, { page: 'balloon.html', ready: `document.body.dataset.ready === '1'` });
});

test('IDE: balloon link and #open= deep links into the uvsd sources', { skip: !chrome || !has('uvsd-doom-obc/Core/Src/main.c') }, async () => {
  await withStaticIde(async ({ evaluate: page, waitFor, errors }) => {
    assert.equal(await page(`document.querySelector('#btn-balloon').getAttribute('href')`), 'balloon.html');
    await page(`location.hash = '#open=' + encodeURIComponent('uvsd/uvsd-doom-obc/Core/Src/main.c')`);
    await waitFor(`document.querySelector('.editor-tab.active')?.title === 'uvsd/uvsd-doom-obc/Core/Src/main.c'`);
    await page(`location.hash = '#open=' + encodeURIComponent('uvsd/uvsd-doom-gs/ground_station/messages.py')`);
    await waitFor(`document.querySelector('.editor-tab.active')?.title === 'uvsd/uvsd-doom-gs/ground_station/messages.py'`);
    assert.equal(await page(`document.querySelector('.CodeMirror').CodeMirror.getMode().name`), 'python');
    assert.deepEqual(errors, []);
  });
});
