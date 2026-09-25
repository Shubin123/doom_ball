// STM32 Forge IDE: editor, real builds via the local server, memory report,
// DOOM emulator, and flashing / serial console over Web Serial and WebUSB.
import { An3155, webSerialTransport } from './flash/an3155.js';
import { DfuSe, DFU_FILTERS } from './flash/dfuse.js';
import { DoomSim, doomKey, loadScript, fromBase64 } from './doom-sim.js';

const $ = (id) => document.getElementById(id);
const TARGETS = {
  h743: { name: 'STM32H743IITx', flash: 2048 * 1024, ram: 1024 * 1024, dfu: true },
  bluepill: { name: 'STM32F103C8T6 Blue Pill', flash: 64 * 1024, ram: 20 * 1024, dfu: false },
};
const DOOM_MIN_ZONE = 704 * 1024;   // smallest zone that ran every demo (tests/sim_headless.mjs)

const state = {
  server: false,
  manifest: null,
  builds: {},          // "target-project" -> build result (from server or manifest)
  files: [],
  open: new Map(),     // path -> { doc, saved }
  active: null,
  port: null,          // Web Serial port shared by console and UART flashing
  console: null,       // { reader, writer } while the console is open
};

const combo = () => `${$('target').value}-${$('project').value}`;
const kb = (n) => (n >= 1024 * 1024 ? `${(n / 1048576).toFixed(2)} MB` : `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`);

// ------------------------------------------------------------ terminals --
function term(name, text, cls) {
  const el = $(`term-${name}`);
  const span = document.createElement('span');
  if (cls) span.className = cls;
  span.textContent = text;
  el.appendChild(span);
  if (el.childNodes.length > 4000) el.removeChild(el.firstChild);
  el.scrollTop = el.scrollHeight;
}
const line = (name, text, cls) => term(name, text + '\n', cls);

function showTerm(name) {
  document.querySelectorAll('.bottom-tabs [data-term]').forEach((b) => b.classList.toggle('active', b.dataset.term === name));
  document.querySelectorAll('.term').forEach((t) => t.classList.toggle('active', t.id === `term-${name}`));
  $('serial-form').hidden = name !== 'serial';
}
document.querySelectorAll('.bottom-tabs [data-term]').forEach((b) => b.addEventListener('click', () => showTerm(b.dataset.term)));
$('btn-clear').addEventListener('click', () => {
  const t = document.querySelector('.term.active');
  if (t) t.textContent = '';
});

// ------------------------------------------------------------ server --
async function detectServer() {
  const s = $('server-status');
  try {
    const r = await fetch('api/status', { cache: 'no-store' });
    if (!r.ok) throw new Error();
    const st = await r.json();
    state.server = true;
    s.innerHTML = st.toolchain
      ? `<span class="dot ok"></span><span>build server · ${st.toolchain.replace(/^arm-none-eabi-gcc /, 'gcc ')}</span>`
      : '<span class="dot warn"></span><span>build server · toolchain not found (set ARM_GCC_PATH)</span>';
  } catch {
    state.server = false;
    s.innerHTML = '<span class="dot warn"></span><span>no build server: prebuilt firmware, read-only sources</span>';
    s.title = 'Run: python3 server/forge_server.py  then open http://localhost:8732/';
  }
  $('btn-build').disabled = !state.server;
  $('btn-build').title = state.server ? 'Build (Ctrl+B)' : 'Start server/forge_server.py to build';
}

// Prebuilt manifest + images as a script (fallback when fetch is blocked).
async function prebuiltScript() {
  if (!window.FORGE_PREBUILT) await loadScript('firmware/prebuilt/prebuilt.js');
  return window.FORGE_PREBUILT;
}

async function loadManifest() {
  try {
    const r = await fetch('firmware/prebuilt/manifest.json', { cache: 'no-store' });
    state.manifest = await r.json();
  } catch {
    try {
      state.manifest = (await prebuiltScript()).manifest;
    } catch {
      state.manifest = { builds: {} };
    }
  }
}

// ------------------------------------------------------------ files --
async function loadTree() {
  try {
    if (state.server) {
      state.files = (await (await fetch('api/tree')).json()).files;
    } else {
      state.files = (await (await fetch('ide/files.json')).json()).files;
    }
  } catch {
    try {
      await loadScript('ide/files.js');
      state.files = window.FORGE_FILES.files;
    } catch {
      state.files = [];
    }
  }
  renderTree();
}

function renderTree() {
  const root = {};
  for (const f of state.files) {
    const parts = f.split('/');
    let node = root;
    parts.slice(0, -1).forEach((p) => { node = node[p] = node[p] || {}; });
    node[parts.at(-1)] = f;
  }
  const tree = $('tree');
  tree.textContent = '';
  const collapsedByDefault = new Set(['doomgeneric']);
  const walk = (node, parent, depth) => {
    const entries = Object.entries(node).sort(([a, av], [b, bv]) =>
      (typeof av === 'string') - (typeof bv === 'string') || a.localeCompare(b));
    for (const [name, v] of entries) {
      if (typeof v === 'string') {
        const el = document.createElement('div');
        el.className = 'file';
        el.style.paddingLeft = `${14 + depth * 12}px`;
        el.textContent = name;
        el.dataset.path = v;
        el.addEventListener('click', () => openFile(v));
        parent.appendChild(el);
      } else {
        const d = document.createElement('div');
        d.className = 'dir' + (collapsedByDefault.has(name) ? ' collapsed' : '');
        d.style.paddingLeft = `${6 + depth * 12}px`;
        d.textContent = name;
        const kids = document.createElement('div');
        kids.className = 'children';
        d.addEventListener('click', () => d.classList.toggle('collapsed'));
        parent.append(d, kids);
        walk(v, kids, depth + 1);
      }
    }
  };
  walk(root, tree, 0);
  if (!state.files.length) tree.innerHTML = '<div class="note">No source listing available.</div>';
  highlightTree();
}

function highlightTree() {
  document.querySelectorAll('.tree .file').forEach((el) => el.classList.toggle('active', el.dataset.path === state.active));
}

let cm = null;
function editor() {
  if (!cm) {
    $('editor-empty').remove();
    cm = CodeMirror($('editor-body'), {
      lineNumbers: true, matchBrackets: true, styleActiveLine: true, indentUnit: 4,
      readOnly: !state.server,
    });
    cm.on('change', () => {
      const f = state.open.get(state.active);
      if (f) renderTabs();
    });
  }
  return cm;
}

function modeFor(path) {
  if (/\.s$/i.test(path)) return { name: 'gas', architecture: 'ARM' };
  if (/Makefile|\.ld$/.test(path)) return 'text/plain';
  return 'text/x-csrc';
}

async function openFile(path) {
  if (!state.open.has(path)) {
    let text;
    try {
      if (state.server) {
        text = (await (await fetch(`api/file?path=${encodeURIComponent(path)}`)).json()).content;
      } else {
        const r = await fetch(path);
        if (!r.ok) throw new Error(r.status);
        text = await r.text();
      }
    } catch (e) {
      line('build', location.protocol === 'file:'
        ? `${path}: browsers don't let a page opened from disk read files. Run python3 server/forge_server.py and open http://localhost:8732/`
        : `could not open ${path}: ${e.message}`, 'err');
      return;
    }
    const doc = CodeMirror.Doc(text, modeFor(path));
    state.open.set(path, { doc, saved: doc.changeGeneration() });
  }
  state.active = path;
  editor().swapDoc(state.open.get(path).doc);
  renderTabs();
  highlightTree();
}

function renderTabs() {
  const tabs = $('tabs');
  tabs.textContent = '';
  for (const [path, f] of state.open) {
    const t = document.createElement('div');
    t.className = 'editor-tab' + (path === state.active ? ' active' : '') +
      (f.doc.isClean(f.saved) ? '' : ' dirty');
    t.title = path;
    t.innerHTML = `<span class="name"></span><span class="x" title="Close">×</span>`;
    t.querySelector('.name').textContent = path.split('/').pop();
    t.addEventListener('click', (e) => {
      if (e.target.classList.contains('x')) return closeFile(path);
      openFile(path);
    });
    tabs.appendChild(t);
  }
  const f = state.open.get(state.active);
  $('btn-save').disabled = !state.server || !f || f.doc.isClean(f.saved);
}

function closeFile(path) {
  const f = state.open.get(path);
  if (f && !f.doc.isClean(f.saved) && !confirm(`Discard unsaved changes to ${path}?`)) return;
  state.open.delete(path);
  if (state.active === path) {
    const next = [...state.open.keys()].pop();
    if (next) openFile(next);
    else {
      state.active = null;
      cm.swapDoc(CodeMirror.Doc(''));
    }
  }
  renderTabs();
}

async function saveAll() {
  if (!state.server) return;
  for (const [path, f] of state.open) {
    if (f.doc.isClean(f.saved)) continue;
    const r = await fetch(`api/file?path=${encodeURIComponent(path)}`, { method: 'PUT', body: f.doc.getValue() });
    if (!r.ok) {
      line('build', `save failed: ${path}`, 'err');
      continue;
    }
    f.saved = f.doc.changeGeneration();
    line('build', `saved ${path}`, 'dim');
  }
  renderTabs();
}
$('btn-save').addEventListener('click', saveAll);

// ------------------------------------------------------------ build --
async function build() {
  if (!state.server) return;
  await saveAll();
  const [target, project] = [$('target').value, $('project').value];
  showTerm('build');
  $('term-build').textContent = '';
  line('build', `$ make TARGET=${target} PROJECT=${project}`, 'dim');
  $('btn-build').disabled = true;
  $('btn-build').textContent = 'Building…';
  const t0 = performance.now();
  try {
    const r = await (await fetch('api/build', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ target, project }),
    })).json();
    for (const l of r.log.split('\n')) {
      const cls = /error|overflowed|will not fit/i.test(l) ? 'err' : /warning/i.test(l) ? 'warn'
        : /^(CC|AS|LD) /.test(l) ? 'dim' : '';
      line('build', l, cls);
    }
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    if (r.ok) {
      line('build', `Build succeeded in ${secs}s: firmware.bin ${kb(r.binarySize)}` +
        (r.zone ? `, DOOM zone heap ${kb(r.zone)}` : ''), 'ok');
    } else {
      line('build', `Build FAILED in ${secs}s`, 'err');
    }
    r.source = 'this build';
    state.builds[`${target}-${project}`] = r;
    renderMemory();
    updateEmulator();
  } catch (e) {
    line('build', `build request failed: ${e.message}`, 'err');
  } finally {
    $('btn-build').disabled = false;
    $('btn-build').textContent = 'Build';
  }
}
$('btn-build').addEventListener('click', build);

function currentBuild() {
  return state.builds[combo()] || (state.manifest && state.manifest.builds[combo()] &&
    { ...state.manifest.builds[combo()], source: 'prebuilt' });
}

// ------------------------------------------------------------ memory --
function renderMemory() {
  const b = currentBuild();
  const t = TARGETS[$('target').value];
  const el = $('memory');
  $('mem-source').textContent = b ? `linker report · ${b.source}` : '';
  if (!b || !b.memory || !b.memory.length) {
    el.innerHTML = `<div class="note">No build yet for this target. ${state.server ? 'Press Build.' : ''}</div>`;
    return;
  }
  const flash = b.memory.filter((m) => m.region === 'FLASH');
  const ram = b.memory.filter((m) => m.region !== 'FLASH');
  const sum = (list, k) => list.reduce((a, m) => a + m[k], 0);
  const flashUsed = sum(flash, 'used');
  const ramStatic = sum(ram, 'used');
  const zone = b.zone || 0;
  const ramSize = sum(ram, 'size');

  const bar = (parts, total, over) => `<div class="bar${over ? ' over' : ''}">${parts
    .map(([cls, v]) => `<span class="${cls}" style="width:${Math.min(100, (v / total) * 100).toFixed(2)}%"></span>`).join('')}</div>`;

  let html = `
    <div class="mem-group">
      <div class="mem-title"><span>Flash</span><span class="big mono">${kb(flashUsed)} / ${kb(t.flash)}</span></div>
      ${bar([['flash', flashUsed]], t.flash, flashUsed > t.flash)}
    </div>
    <div class="mem-group">
      <div class="mem-title"><span>RAM</span><span class="big mono">${kb(ramStatic + zone)} / ${kb(ramSize)}</span></div>
      ${bar([['ram', ramStatic], ['zone', zone]], ramSize, ramStatic > ramSize)}
      <div class="legend"><span><i style="background:var(--bar-ram)"></i>static data, heap, stack ${kb(ramStatic)}</span>
      ${zone ? `<span><i style="background:var(--bar-zone)"></i>DOOM zone heap ${kb(zone)}</span>` : ''}</div>
    </div>
    <div class="mem-regions">`;
  for (const m of b.memory) {
    const over = m.overflow > 0 || m.used > m.size;
    html += `<span class="name">${m.region}</span>${bar([[m.region === 'FLASH' ? 'flash' : 'ram', m.used]], m.size, over)}
      <span class="num${over ? ' over' : ''}">${kb(m.used)} / ${kb(m.size)}</span>`;
  }
  html += '</div>';

  if (!b.ok) {
    const overs = b.memory.filter((m) => m.overflow).map((m) => `${m.region} overflowed by ${kb(m.overflow)}`);
    html += `<div class="verdict bad">Does not fit on the ${t.name}: ${overs.join(', ') || 'link failed'}.</div>`;
  } else if ($('project').value === 'doom') {
    html += `<div class="verdict ok">Fits. DOOM gets a ${kb(zone)} zone heap (needs ≥ ${kb(DOOM_MIN_ZONE)}).</div>`;
  } else {
    html += `<div class="verdict ok">Fits: ${kb(flashUsed)} flash, ${kb(ramStatic)} RAM.</div>`;
  }
  el.innerHTML = html;
}

// ------------------------------------------------------------ emulator --
const sim = new DoomSim($('screen'), {
  onStatus: (s) => { $('emu-fps').textContent = s; },
  onExit: (reason) => {
    $('btn-run').disabled = false;
    $('btn-stop').disabled = true;
    $('emu-fps').textContent = '';
    overlay(`<strong>DOOM stopped</strong><span class="mono">${escapeHtml(reason)}</span>`, true);
  },
});

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function overlay(html, bad) {
  const o = $('emu-overlay');
  o.hidden = !html;
  o.className = 'overlay' + (bad ? ' bad' : '');
  o.innerHTML = html || '';
}

function updateEmulator() {
  if (sim.running) return;
  const target = $('target').value;
  const project = $('project').value;
  const b = currentBuild();
  $('btn-run').disabled = false;
  if (project !== 'doom') {
    overlay('<strong>Blinky has no display</strong><span>It toggles the LED on PC13 and prints to USART1: flash it and open the serial monitor.</span>');
    $('btn-run').disabled = true;
    $('emu-note').textContent = '';
    return;
  }
  if (target === 'bluepill') {
    const ram = b && b.memory ? b.memory.find((m) => m.region === 'RAM') : null;
    overlay(`<strong>DOOM does not fit on a Blue Pill</strong>
      <span>The linker needs ${ram ? kb(ram.used) : 'about 1 MB'} of RAM; the STM32F103C8 has 20 KB.
      DOOM's heap alone needs at least ${kb(DOOM_MIN_ZONE)}.</span>
      <span>Press Run to start the engine with a 20 KB heap anyway and watch it fail.</span>`, true);
    $('emu-note').textContent = 'Blue Pill budget: 20 KB of RAM in total.';
    return;
  }
  const banks = b && b.zoneBanks;
  overlay(`<strong>Real DOOM, same engine source as the firmware</strong>
    <span>Heap limited to the H743 build: ${banks ? banks.map(kb).join(' + ') : '?'} across DTCM, AXI SRAM and SRAM1-3.</span>
    <span>Press Run, then click the screen for keyboard input.</span>`);
  $('emu-note').textContent = banks ? `Zone heap: ${kb(banks.reduce((a, x) => a + x, 0))} in ${banks.length} banks.` : '';
}

$('btn-run').addEventListener('click', async () => {
  const target = $('target').value;
  const b = currentBuild();
  let banks;
  if (target === 'bluepill') banks = [20 * 1024];
  else if (b && b.zoneBanks) banks = b.zoneBanks;
  else banks = [12336, 416672, 294912];
  $('btn-run').disabled = true;
  overlay('<strong>Loading DOOM1.WAD…</strong>');
  try {
    await sim.start(banks);
    if (sim.running) {
      overlay('');
      $('btn-stop').disabled = false;
      $('screen').focus();
    }
  } catch (e) {
    $('btn-run').disabled = false;
    overlay(`<strong>Could not start</strong><span>${escapeHtml(e.message)}</span>`, true);
  }
});
$('btn-stop').addEventListener('click', () => {
  sim.stop();
  $('btn-stop').disabled = true;
  $('emu-fps').textContent = '';
  updateEmulator();
});

function onKey(pressed, e) {
  const code = doomKey(e);
  if (code == null) return;
  e.preventDefault();
  sim.key(pressed, code);
  if ($('pad-hw').checked && state.console) {
    state.console.writer.write(Uint8Array.of(pressed ? 0xf0 : 0xf1, code)).catch(() => {});
  }
}
$('screen').addEventListener('keydown', (e) => { if (!e.repeat) onKey(true, e); else e.preventDefault(); });
$('screen').addEventListener('keyup', (e) => onKey(false, e));
$('screen').addEventListener('click', () => $('screen').focus());

// ------------------------------------------------------------ serial console --
async function openConsole() {
  if (!('serial' in navigator)) {
    line('serial', 'Web Serial is not available in this browser (use Chrome or Edge).', 'err');
    showTerm('serial');
    return;
  }
  try {
    state.port = state.port || await navigator.serial.requestPort();
    await state.port.open({ baudRate: 115200 });
  } catch (e) {
    line('serial', `could not open port: ${e.message}`, 'err');
    showTerm('serial');
    return;
  }
  const reader = state.port.readable.getReader();
  const writer = state.port.writable.getWriter();
  state.console = { reader, writer };
  $('btn-serial').textContent = 'Disconnect serial';
  showTerm('serial');
  line('serial', '— connected at 115200 8N1 —', 'ok');
  const dec = new TextDecoder();
  (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        term('serial', dec.decode(value, { stream: true }).replace(/\r/g, ''));
      }
    } catch (e) {
      line('serial', `— ${e.message} —`, 'warn');
    }
  })();
}

async function closeConsole() {
  if (!state.console) return;
  const { reader, writer } = state.console;
  state.console = null;
  try { await reader.cancel(); } catch { /* already closed */ }
  reader.releaseLock();
  writer.releaseLock();
  try { await state.port.close(); } catch { /* ignore */ }
  $('btn-serial').textContent = 'Connect serial';
  line('serial', '— disconnected —', 'dim');
}

$('btn-serial').addEventListener('click', () => (state.console ? closeConsole() : openConsole()));
$('serial-form').addEventListener('submit', (e) => {
  e.preventDefault();
  if (!state.console) return;
  const text = $('serial-line').value + '\r';
  state.console.writer.write(new TextEncoder().encode(text));
  $('serial-line').value = '';
});

// ------------------------------------------------------------ flashing --
async function firmwareImage() {
  const b = state.builds[combo()];
  if (b && b.ok && b.binary) {
    return { bytes: fromBase64(b.binary), from: 'your latest build' };
  }
  const from = `prebuilt firmware/prebuilt/${combo()}.bin`;
  try {
    const r = await fetch(`firmware/prebuilt/${combo()}.bin`, { cache: 'no-store' });
    if (r.ok) return { bytes: new Uint8Array(await r.arrayBuffer()), from };
  } catch {
    const pre = await prebuiltScript().catch(() => null);
    const b64 = pre && pre.images[combo()];
    if (b64) return { bytes: fromBase64(b64), from };
  }
  return null;
}

function progress(phase, done, total) {
  const p = $('flash-progress');
  p.hidden = false;
  const pct = phase === 'erase' ? 5 * (done / total) : phase === 'write' ? 5 + 75 * (done / total) : 80 + 20 * (done / total);
  p.firstElementChild.style.width = `${pct.toFixed(1)}%`;
}

$('btn-flash').addEventListener('click', async () => {
  const t = TARGETS[$('target').value];
  const b = currentBuild();
  if (b && b.ok === false) {
    showTerm('flash');
    line('flash', `${combo()} does not fit on the ${t.name}; nothing to flash.`, 'err');
    return;
  }
  const img = await firmwareImage();
  if (!img) {
    showTerm('flash');
    line('flash', 'No firmware image: build first.', 'err');
    return;
  }
  $('fd-what').textContent = `${$('project').selectedOptions[0].text} → ${t.name}`;
  $('fd-image').textContent = `${kb(img.bytes.length)} from ${img.from}`;
  $('m-dfu').classList.toggle('disabled', !t.dfu);
  if (!t.dfu) $('m-uart').querySelector('input').checked = true;
  const support = [];
  if (!('serial' in navigator)) support.push('Web Serial is not available in this browser');
  if (!('usb' in navigator)) support.push('WebUSB is not available in this browser');
  $('fd-support').textContent = support.length ? `${support.join('; ')}. Use Chrome or Edge.` : '';
  $('flash-dialog').returnValue = '';
  $('flash-dialog').showModal();
  $('flash-dialog').onclose = () => {
    if ($('flash-dialog').returnValue === 'go') {
      const method = new FormData($('flash-dialog').querySelector('form')).get('method');
      flash(method, img.bytes);
    }
  };
});

async function flash(method, image) {
  showTerm('flash');
  const log = (s) => line('flash', s);
  const t0 = performance.now();
  try {
    if (method === 'dfu') {
      const dev = await navigator.usb.requestDevice({ filters: DFU_FILTERS });
      const dfu = new DfuSe(dev, log);
      await dfu.open();
      await dfu.flash(image, { onProgress: progress });
    } else {
      await closeConsole();
      state.port = state.port || await navigator.serial.requestPort();
      const transport = await webSerialTransport(state.port);
      try {
        const bl = new An3155(transport, log);
        await bl.connect();
        await bl.flash(image, { onProgress: progress });
      } finally {
        await transport.close();
      }
    }
    line('flash', `Flashed and verified ${kb(image.length)} in ${((performance.now() - t0) / 1000).toFixed(1)}s. ` +
      'Set BOOT0 low and reset if the board does not start by itself.', 'ok');
  } catch (e) {
    line('flash', `Flash failed: ${e.message}`, 'err');
    if (method === 'uart') line('flash', 'Check: BOOT0 high, board reset after that, TX→PA10 / RX→PA9, adapter at 3.3 V.', 'dim');
  } finally {
    setTimeout(() => { $('flash-progress').hidden = true; }, 1500);
  }
}

// ------------------------------------------------------------ wiring --
function onSelection() {
  renderMemory();
  if (sim.running) sim.stop(), $('btn-stop').disabled = true;
  updateEmulator();
  const t = $('target').value, p = $('project').value;
  const main = p === 'doom' ? (t === 'h743' ? 'firmware/targets/h743/dg_stm32.c' : 'firmware/targets/bluepill/dg_bluepill.c')
    : 'firmware/projects/blinky/main.c';
  if (state.files.includes(main)) openFile(main);
}
$('target').addEventListener('change', onSelection);
$('project').addEventListener('change', onSelection);

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); saveAll(); }
  if ((e.ctrlKey || e.metaKey) && e.key === 'b') { e.preventDefault(); build(); }
});
window.addEventListener('beforeunload', (e) => {
  if ([...state.open.values()].some((f) => !f.doc.isClean(f.saved))) e.preventDefault();
});

(async () => {
  await Promise.all([detectServer(), loadManifest()]);
  await loadTree();
  line('build', state.server
    ? 'Ready. Build runs arm-none-eabi-gcc on this machine (Ctrl+B).'
    : 'Build server not running: showing the prebuilt firmware\'s linker report. ' +
      'Run `python3 server/forge_server.py` and open http://localhost:8732/ to build.', 'dim');
  onSelection();
})();
