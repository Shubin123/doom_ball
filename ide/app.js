// STM32 Forge IDE: editor, browser/local builds, memory report,
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
  projects: [],
  projectGroups: [],
  open: new Map(),     // path -> { doc, saved }
  active: null,
  port: null,          // Web Serial port shared by console and UART flashing
  console: null,       // { reader, writer } while the console is open
};
const DRAFT_KEY = 'stm32-forge-drafts-v1';
function drafts() {
  try { return JSON.parse(localStorage.getItem(DRAFT_KEY) || '{}'); }
  catch { return {}; }
}

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
    s.innerHTML = '<span class="dot ok"></span><span>static IDE · browser build · local drafts</span>';
    s.title = 'Source edits and firmware builds run in this browser. Flashing uses Web Serial or WebUSB.';
  }
  $('btn-build').disabled = false;
  $('btn-build').title = state.server ? 'Build (Ctrl+B)' : 'Build H743 firmware in this browser (Ctrl+B)';
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

async function loadProjectCatalog() {
  let groups = [];
  const fallback = [
    { id: 'doom', name: 'DOOM', group: 'games', description: 'Playable DOOM on the H743.', entry: 'firmware/targets/h743/dg_stm32.c', targets: ['h743'], emulator: true },
    { id: 'blinky', name: 'Blinky', group: 'basics', description: 'Blink PC13 and report over USART1.', entry: 'firmware/projects/blinky/main.c', targets: ['h743', 'bluepill'] },
  ];
  try {
    const response = await fetch('firmware/projects/catalog.json', { cache: 'no-store' });
    if (!response.ok) throw new Error('catalog unavailable');
    const catalog = await response.json();
    state.projects = catalog.projects;
    groups = catalog.groups;
  } catch {
    state.projects = fallback;
    groups = [{ id: 'games', name: 'Games' }, { id: 'basics', name: 'Getting started' }];
  }
  state.projectGroups = groups;
  const select = $('project');
  select.textContent = '';
  for (const group of new Set(state.projects.map((project) => project.group))) {
    const optgroup = document.createElement('optgroup');
    optgroup.label = groups.find((item) => item.id === group)?.name || group;
    for (const project of state.projects.filter((item) => item.group === group)) {
      const option = document.createElement('option');
      option.value = project.id;
      option.textContent = project.name;
      option.dataset.targets = project.targets.join(',');
      optgroup.appendChild(option);
    }
    select.appendChild(optgroup);
  }
  refreshProjectAvailability();
}

function projectInfo() {
  return state.projects.find((project) => project.id === $('project').value) || state.projects[0];
}

function refreshProjectAvailability() {
  const target = $('target').value;
  for (const option of $('project').options) {
    option.disabled = !option.dataset.targets.split(',').includes(target);
  }
  if ($('project').selectedOptions[0]?.disabled) {
    const next = [...$('project').options].find((option) => !option.disabled);
    if (next) $('project').value = next.value;
  }
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

let sourceSearchRun = 0;
async function searchSources() {
  const query = $('source-search-query').value;
  const resultsEl = $('source-search-results');
  const status = $('source-search-status');
  const run = ++sourceSearchRun;
  resultsEl.textContent = '';
  if (!query) { status.textContent = 'Enter a word or regular expression.'; return; }
  const files = state.files.slice();
  const localDrafts = drafts();
  status.textContent = `Searching ${files.length} source files…`;
  let resultSet;
  try {
    resultSet = await searchSourceFiles(files, query, {
      regex: $('source-search-regex').checked,
      isCurrent: () => run === sourceSearchRun,
      readFile: async (path) => {
        const opened = state.open.get(path);
        if (opened) return opened.doc.getValue();
        if (localDrafts[path] != null) return localDrafts[path];
        if (state.server) {
          const response = await fetch(`api/file?path=${encodeURIComponent(path)}`);
          if (!response.ok) throw new Error(`${response.status}`);
          return (await response.json()).content;
        }
        const response = await fetch(path);
        if (!response.ok) throw new Error(`${response.status}`);
        return response.text();
      },
      onProgress: ({ completed, total, matches }) => {
        if (completed % 20 === 0 || completed === total) status.textContent = `Searching… ${completed}/${total} files · ${matches} matches`;
      },
    });
  } catch (error) { status.textContent = `Search error: ${error.message}`; return; }
  if (run !== sourceSearchRun) return;
  for (const result of resultSet.matches) {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'search-result'; button.setAttribute('role', 'listitem');
    const path = document.createElement('span'); path.className = 'search-result-path'; path.textContent = `${result.path}:${result.line}`;
    const snippet = document.createElement('span'); snippet.className = 'search-result-snippet'; snippet.textContent = result.snippet;
    button.append(path, snippet);
    button.addEventListener('click', async () => {
      await openFile(result.path);
      if (state.active !== result.path || !cm) return;
      cm.setCursor({ line: result.line - 1, ch: result.column });
      cm.scrollIntoView({ line: result.line - 1, ch: result.column }, 80);
      cm.focus();
    });
    resultsEl.appendChild(button);
  }
  status.textContent = `${resultSet.matches.length}${resultSet.limitReached ? '+' : ''} matches in ${resultSet.completed} files` +
    (resultSet.failed ? ` · ${resultSet.failed} files could not be read` : '') +
    (resultSet.limitReached ? ' · result limit reached' : '');
}
$('source-search-form').addEventListener('submit', (event) => { event.preventDefault(); searchSources(); });

let cm = null;
function editor() {
  if (!cm) {
    $('editor-empty').remove();
    cm = CodeMirror($('editor-body'), {
      lineNumbers: true, matchBrackets: true, styleActiveLine: true, indentUnit: 4,
      readOnly: false,
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
        ? `${path}: browsers block reading project files from file://. Open the online demo or run node server/forge_server.mjs in a local checkout.`
        : `could not open ${path}: ${e.message}`, 'err');
      return;
    }
    if (!state.server) text = drafts()[path] ?? text;
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
  $('btn-save').disabled = !f || f.doc.isClean(f.saved);
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
  const local = drafts();
  let saved = 0;
  for (const [path, f] of state.open) {
    if (f.doc.isClean(f.saved)) continue;
    if (state.server) {
      const r = await fetch(`api/file?path=${encodeURIComponent(path)}`, { method: 'PUT', body: f.doc.getValue() });
      if (!r.ok) {
        line('build', `save failed: ${path}`, 'err');
        continue;
      }
    } else {
      local[path] = f.doc.getValue();
    }
    f.saved = f.doc.changeGeneration();
    saved++;
  }
  if (!state.server && saved) {
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify(local));
      line('build', `saved ${saved} browser draft${saved === 1 ? '' : 's'} on this device`, 'ok');
    } catch (e) {
      line('build', `could not save browser drafts: ${e.message}`, 'err');
      return;
    }
  } else if (state.server && saved) line('build', `saved ${saved} file${saved === 1 ? '' : 's'} to the checkout`, 'dim');
  renderTabs();
}
$('btn-save').addEventListener('click', saveAll);

// ------------------------------------------------------------ build --
async function build() {
  if (!state.server) {
    showTerm('build');
    if ($('target').value !== 'h743') {
      line('build', 'Browser firmware builds currently target the STM32H743. Select that board to build here.', 'warn');
      return;
    }
    await buildInBrowser();
    return;
  }
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

async function buildInBrowser() {
  const [target, project] = [$('target').value, $('project').value];
  const selected = projectInfo();
  showTerm('build');
  $('term-build').textContent = '';
  if (!selected || !selected.targets.includes(target)) {
    line('build', 'Select an example supported by the current board.', 'warn');
    return;
  }
  $('btn-build').disabled = true;
  $('btn-build').textContent = 'Loading compiler…';
  const started = performance.now();
  try {
    const source = async (path) => {
      const open = state.open.get(path);
      if (open) return open.doc.getValue();
      const response = await fetch(path);
      return response.ok ? response.text() : null;
    };
    line('build', 'Loading pinned ARM compiler and runtime (~98 MB, cached by browser)…', 'dim');
    const result = await browserH743Build({
      project,
      projectConfig: selected,
      files: state.files,
      source,
      onLog: (message) => {
        line('build', message, /error|overflow/i.test(message) ? 'err' : /compiled|region|used size/i.test(message) ? 'dim' : '');
        $('btn-build').textContent = 'Compiling…';
      },
    });
    result.source = 'browser WebAssembly Clang build';
    state.builds[`${target}-${project}`] = result;
    const secs = ((performance.now() - started) / 1000).toFixed(1);
    line('build', `Build succeeded in ${secs}s: firmware.bin ${kb(result.binarySize)}` +
      (project === 'doom' ? `, DOOM zone heap ${kb(result.zone)}` : ''), 'ok');
    renderMemory();
    updateEmulator();
  } catch (error) {
    line('build', `Build failed: ${error.message}`, 'err');
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
const examplePreview = new ExamplePreview($('example-view'));

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function overlay(html, bad) {
  const o = $('emu-overlay');
  o.hidden = !html;
  o.className = 'overlay' + (bad ? ' bad' : '');
  o.innerHTML = html || '';
}

async function sourceForSimulation(path) {
  const opened = state.open.get(path);
  if (opened) return opened.doc.getValue();
  const localDrafts = drafts();
  if (localDrafts[path] != null) return localDrafts[path];
  if (state.server) {
    const response = await fetch(`api/file?path=${encodeURIComponent(path)}`);
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
    return (await response.json()).content;
  }
  const response = await fetch(path);
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.text();
}

function updateEmulator() {
  if (sim.running) return;
  const target = $('target').value;
  const project = $('project').value;
  const b = currentBuild();
  const example = projectInfo();
  $('btn-run').disabled = false;
  if (project !== 'doom') {
    $('emu-title').textContent = 'Example C simulation · virtual STM32 HAL';
    $('screen').hidden = true;
    overlay('');
    void examplePreview.show(example, { target, readSource: sourceForSimulation });
    $('btn-run').disabled = true;
    $('btn-stop').disabled = true;
    $('pad-hw').closest('label').hidden = true;
    $('screen').parentElement.nextElementSibling.hidden = true;
    $('screen').parentElement.nextElementSibling.nextElementSibling.hidden = true;
    $('screen-brightness').closest('.brightness-control').hidden = true;
    $('emu-note').textContent = '';
    return;
  }
  $('emu-title').textContent = 'Emulator — DOOM engine (WebAssembly)';
  examplePreview.hide();
  $('screen').hidden = false;
  $('pad-hw').closest('label').hidden = false;
  $('screen').parentElement.nextElementSibling.hidden = false;
  $('screen').parentElement.nextElementSibling.nextElementSibling.hidden = false;
  $('screen-brightness').closest('.brightness-control').hidden = false;
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
  if (!img.bytes.length || img.bytes.length > t.flash) {
    showTerm('flash');
    line('flash', `Firmware image is ${kb(img.bytes.length)}; ${t.name} has ${kb(t.flash)} flash.`, 'err');
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
      const file = $('custom-firmware').files[0];
      if (!file) {
        flash(method, img.bytes);
        return;
      }
      file.arrayBuffer().then((buffer) => {
        const bytes = new Uint8Array(buffer);
        if (!bytes.length || bytes.length > t.flash) {
          showTerm('flash');
          line('flash', `Firmware image is ${kb(bytes.length)}; ${t.name} has ${kb(t.flash)} flash.`, 'err');
          return;
        }
        flash(method, bytes);
      }).catch((e) => {
        showTerm('flash');
        line('flash', `Could not read firmware image: ${e.message}`, 'err');
      });
    }
  };
});

$('custom-firmware').addEventListener('change', () => {
  const file = $('custom-firmware').files[0];
  if (file) $('fd-image').textContent = `${kb(file.size)} from rebuilt image ${file.name}`;
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
  refreshProjectAvailability();
  renderMemory();
  if (sim.running) sim.stop(), $('btn-stop').disabled = true;
  updateEmulator();
  const project = projectInfo();
  const main = project?.entry || 'firmware/projects/blinky/main.c';
  $('example-name').textContent = project?.name || 'Firmware example';
  $('example-description').textContent = project?.description || '';
  $('example-targets').textContent = project?.targets.map((target) => target.toUpperCase()).join(' · ') || '';
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
  await Promise.all([detectServer(), loadManifest(), loadProjectCatalog()]);
  await loadTree();
  line('build', state.server
    ? 'Ready. Build runs arm-none-eabi-gcc on this machine (Ctrl+B).'
    : 'Static IDE ready: edit sources, build H743 firmware in the browser, and flash with Web Serial or WebUSB. Browser drafts stay on this device.', 'dim');
  onSelection();
})();

const brightnessInput = $('screen-brightness');
const brightnessValue = $('screen-brightness-value');
function setGameBrightness(value) {
  const percent = Math.max(100, Math.min(175, Number(value) || 140));
  $('screen').style.filter = `brightness(${percent / 100}) saturate(1.08)`;
  brightnessInput.value = String(percent);
  brightnessValue.value = `${percent}%`;
}
brightnessInput.addEventListener('input', () => {
  setGameBrightness(brightnessInput.value);
  localStorage.setItem('stm32-forge-game-brightness', brightnessInput.value);
});
setGameBrightness(localStorage.getItem('stm32-forge-game-brightness') || brightnessInput.value);
initWindowManager();
