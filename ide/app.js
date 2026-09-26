// STM32 Forge IDE: editor, browser/local builds, memory report,
// DOOM emulator, and flashing / serial console over Web Serial and WebUSB.
import { An3155, webSerialTransport } from './flash/an3155.js';
import { DfuSe, DFU_FILTERS } from './flash/dfuse.js';
import { StLink, STLINK_FILTERS, isStLink } from './flash/stlink.js';
import { browserBuild, BROWSER_TARGETS } from './browser-build.js';
import { DoomSim, doomKey, loadScript, fromBase64 } from './doom-sim.js';

const $ = (id) => document.getElementById(id);
const TARGETS = {
  h743: { name: 'STM32H743IITx', flash: 2048 * 1024, ram: 1024 * 1024, dfu: true },
  bluepill: { name: 'STM32F103C8T6 Blue Pill', flash: 64 * 1024, ram: 20 * 1024, dfu: false },
  // Nucleo-F401RE: flashed through its on-board ST-Link (instant flash, the default).
  f401: { name: 'STM32F401RE Nucleo-F401RE', flash: 512 * 1024, ram: 96 * 1024, dfu: false, stlink: [0x433, 0x423] },
};
const TARGET_KEY = 'stm32-forge-target';
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
  flashing: false,
};
const DRAFT_KEY = 'stm32-forge-drafts-v1';
const BASELINE_KEY = 'stm32-forge-baselines-v1';
const MODIFIED_KEY = 'stm32-forge-modified-v1';
const autosaveTimers = new Map();
const autosaveWrites = new Map();
function drafts() {
  try { return JSON.parse(localStorage.getItem(DRAFT_KEY) || '{}'); }
  catch { return {}; }
}
function storedObject(key) {
  try { return JSON.parse(localStorage.getItem(key) || '{}') || {}; }
  catch { return {}; }
}
function saveStoredObject(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}
function autosaveStatus(message, failed = false) {
  const status = $('autosave-status');
  status.textContent = message;
  status.classList.toggle('failed', failed);
}
function rememberBaseline(path, text) {
  const baselines = storedObject(BASELINE_KEY);
  if (Object.hasOwn(baselines, path)) return;
  baselines[path] = text;
  try { saveStoredObject(BASELINE_KEY, baselines); }
  catch { autosaveStatus('Autosave storage full', true); }
}
function syncModifiedFile(path, text) {
  const baselines = storedObject(BASELINE_KEY), modified = storedObject(MODIFIED_KEY);
  if (!Object.hasOwn(baselines, path)) return;
  if (text === baselines[path]) delete modified[path];
  else modified[path] = true;
  try { saveStoredObject(MODIFIED_KEY, modified); }
  catch { autosaveStatus('Autosave storage full', true); }
  renderModifiedFiles();
}
function modifiedPaths() {
  const modified = storedObject(MODIFIED_KEY);
  for (const [path, file] of state.open) syncModifiedFile(path, file.doc.getValue());
  return Object.keys(storedObject(MODIFIED_KEY)).sort();
}
function renderModifiedFiles() {
  const paths = Object.keys(storedObject(MODIFIED_KEY)).sort();
  const warning = $('modified-warning');
  warning.hidden = paths.length === 0;
  $('modified-count').textContent = `${paths.length} file${paths.length === 1 ? '' : 's'}`;
  const list = $('modified-files'); list.textContent = '';
  for (const path of paths) {
    const item = document.createElement('li');
    const link = document.createElement('button');
    link.type = 'button'; link.className = 'modified-file'; link.textContent = path;
    link.addEventListener('click', () => openFile(path));
    item.appendChild(link); list.appendChild(item);
  }
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
  $('btn-build').title = state.server ? 'Build (Ctrl+B)' : 'Build H743 or Nucleo-F401RE firmware in this browser (Ctrl+B)';
  autosaveStatus(state.server ? 'Autosave writes to checkout' : 'Autosave writes on this device');
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
    { id: 'freertos', name: 'FreeRTOS tasks', group: 'rtos', description: 'Run preemptive LED and serial-monitor tasks with FreeRTOS on the H743.', entry: 'firmware/projects/freertos/main.c', targets: ['h743'], sources: [] },
  ];
  try {
    const response = await fetch('firmware/projects/catalog.json', { cache: 'no-store' });
    if (!response.ok) throw new Error('catalog unavailable');
    const catalog = await response.json();
    state.projects = catalog.projects;
    groups = catalog.groups;
  } catch {
    state.projects = fallback;
    groups = [{ id: 'games', name: 'Games' }, { id: 'basics', name: 'Getting started' }, { id: 'rtos', name: 'Real-time OS' }];
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
      if (f) {
        renderTabs();
        syncModifiedFile(state.active, f.doc.getValue());
        scheduleAutosave(state.active, f);
      }
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
    rememberBaseline(path, text);
    if (!state.server) text = drafts()[path] ?? text;
    const doc = CodeMirror.Doc(text, modeFor(path));
    state.open.set(path, { doc, saved: doc.changeGeneration() });
    syncModifiedFile(path, text);
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
}

async function closeFile(path) {
  const f = state.open.get(path);
  if (f && !f.doc.isClean(f.saved)) {
    clearTimeout(autosaveTimers.get(path)); autosaveTimers.delete(path);
    if (!await saveDocument(path, f) || !f.doc.isClean(f.saved)) return;
  }
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
  const pending = [...state.open.entries()].map(([path, file]) => {
    clearTimeout(autosaveTimers.get(path)); autosaveTimers.delete(path);
    return saveDocument(path, file);
  });
  const results = await Promise.all(pending);
  return results.every(Boolean);
}

function scheduleAutosave(path, file, delay = 450) {
  clearTimeout(autosaveTimers.get(path));
  if (!file || file.doc.isClean(file.saved)) return;
  autosaveStatus('Saving…');
  autosaveTimers.set(path, setTimeout(() => {
    autosaveTimers.delete(path);
    void saveDocument(path, file);
  }, delay));
}

async function saveDocument(path, file) {
  if (!file || file.doc.isClean(file.saved)) return true;
  const previous = autosaveWrites.get(path);
  if (previous) {
    await previous.catch(() => false);
    return file.doc.isClean(file.saved) ? true : saveDocument(path, file);
  }
  const write = (async () => {
    const generation = file.doc.changeGeneration();
    const content = file.doc.getValue();
    try {
      if (state.server) {
        const response = await fetch(`api/file?path=${encodeURIComponent(path)}`, { method: 'PUT', body: content });
        if (!response.ok) throw new Error(`server returned HTTP ${response.status}`);
      } else {
        const local = drafts(); local[path] = content;
        saveStoredObject(DRAFT_KEY, local);
      }
      file.saved = generation;
      syncModifiedFile(path, content);
      renderTabs();
      if (file.doc.isClean(file.saved)) autosaveStatus(state.server ? 'Saved to checkout' : 'Saved on this device');
      else scheduleAutosave(path, file, 150);
      return true;
    } catch (error) {
      autosaveStatus('Autosave failed; retrying', true);
      line('build', `autosave failed for ${path}: ${error.message}`, 'err');
      scheduleAutosave(path, file, 2500);
      return false;
    }
  })();
  autosaveWrites.set(path, write);
  try { return await write; }
  finally { if (autosaveWrites.get(path) === write) autosaveWrites.delete(path); }
}

async function resetModifiedSamples() {
  if (!await saveAll()) return;
  await Promise.all([...autosaveWrites.values()].map((write) => write.catch(() => false)));
  const paths = modifiedPaths();
  if (!paths.length) return;
  const baselines = storedObject(BASELINE_KEY);
  if (paths.some((path) => !Object.hasOwn(baselines, path))) {
    autosaveStatus('Cannot reset: a baseline is missing', true); return;
  }
  try {
    const changes = drafts();
    for (const path of paths) {
      const content = baselines[path];
      if (state.server) {
        const response = await fetch(`api/file?path=${encodeURIComponent(path)}`, { method: 'PUT', body: content });
        if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
      } else delete changes[path];
      const file = state.open.get(path);
      if (file) {
        file.doc.setValue(content); file.saved = file.doc.changeGeneration();
        clearTimeout(autosaveTimers.get(path)); autosaveTimers.delete(path);
      }
    }
    if (!state.server) saveStoredObject(DRAFT_KEY, changes);
    saveStoredObject(MODIFIED_KEY, {});
    renderTabs(); renderModifiedFiles();
    autosaveStatus('Samples restored to defaults');
  } catch (error) {
    autosaveStatus('Reset failed', true);
    line('build', `sample reset failed: ${error.message}`, 'err');
  }
}

$('btn-reset-samples').addEventListener('click', () => {
  const paths = modifiedPaths();
  if (!paths.length) return;
  const list = $('reset-file-list'); list.textContent = '';
  for (const path of paths) { const item = document.createElement('li'); item.textContent = path; list.appendChild(item); }
  $('reset-dialog').showModal();
});
$('confirm-reset-samples').addEventListener('click', (event) => {
  event.preventDefault(); $('reset-dialog').close(); void resetModifiedSamples();
});

// ------------------------------------------------------------ build --
async function build() {
  if (!await saveAll()) {
    showTerm('build');
    line('build', 'Build stopped because one or more edited files could not be autosaved.', 'err');
    return;
  }
  if (!state.server) {
    showTerm('build');
    if (!BROWSER_TARGETS[$('target').value]) {
      line('build', 'Browser firmware builds support the STM32H743 and the Nucleo-F401RE. Select one of those boards to build here.', 'warn');
      return;
    }
    await buildInBrowser();
    return;
  }
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
    line('build', 'Loading the ARM compiler from this site (~98 MB on first build, then cached by the browser)…', 'dim');
    const result = await browserBuild({
      target,
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
const clockDiagram = new ClockDiagram($('clock-diagram'));

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
    <span>Hardware note: DOOM1.WAD (~4.2 MB) exceeds the 2 MB internal flash and is read from a FAT32 microSD card via SDMMC1.</span>
    <span>Press Run, then click the screen for keyboard input.</span>`);
  $('emu-note').textContent = banks ? `Zone heap: ${kb(banks.reduce((a, x) => a + x, 0))} in ${banks.length} banks. Real board loads 4 MB DOOM1.WAD from microSD.` : '';
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
// The ST-Link's USB serial port, if this site was allowed to use it before.
async function stlinkSerialPort() {
  if (!('serial' in navigator)) return null;
  const ports = await navigator.serial.getPorts().catch(() => []);
  return ports.find((p) => {
    const info = p.getInfo();
    return isStLink({ vendorId: info.usbVendorId, productId: info.usbProductId });
  }) || null;
}

async function openConsole(port = null, { quiet = false } = {}) {
  if (!('serial' in navigator)) {
    line('serial', 'Web Serial is not available in this browser (use Chrome or Edge).', 'err');
    showTerm('serial');
    return false;
  }
  try {
    if (port) state.port = port;
    else if (TARGETS[$('target').value].stlink) state.port = state.port || await stlinkSerialPort();
    state.port = state.port || await navigator.serial.requestPort();
    await state.port.open({ baudRate: 115200 });
  } catch (e) {
    const busy = /Failed to open serial port/i.test(e.message);
    line(quiet ? 'flash' : 'serial', `could not open the serial port: ${e.message}` +
      (busy ? ' Another tab or program (a serial monitor, screen, another IDE window) has it open; close that and connect again.' : ''), 'err');
    if (!quiet) showTerm('serial');
    return false;
  }
  const reader = state.port.readable.getReader();
  const writer = state.port.writable.getWriter();
  state.console = { reader, writer };
  $('btn-serial').textContent = 'Disconnect serial';
  line('serial', '— connected at 115200 8N1 —', 'ok');
  if (!quiet) showTerm('serial');
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
  return true;
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

// The image to flash for the current selection, checked against the board;
// logs why and returns null when there is nothing flashable.
async function flashImage() {
  const t = TARGETS[$('target').value];
  const b = currentBuild();
  if (b && b.ok === false) {
    showTerm('flash');
    line('flash', `${combo()} does not fit on the ${t.name}; nothing to flash.`, 'err');
    return null;
  }
  const img = await firmwareImage();
  if (!img) {
    showTerm('flash');
    line('flash', 'No firmware image: build first.', 'err');
    return null;
  }
  if (!img.bytes.length || img.bytes.length > t.flash) {
    showTerm('flash');
    line('flash', `Firmware image is ${kb(img.bytes.length)}; ${t.name} has ${kb(t.flash)} flash.`, 'err');
    return null;
  }
  return img;
}

function updateFlashButton() {
  const instant = !!TARGETS[$('target').value].stlink;
  $('btn-flash').textContent = instant ? 'Flash' : 'Flash…';
  $('btn-flash').title = instant
    ? 'Instant flash over USB through the on-board ST-Link: no BOOT0 jumper, no buttons'
    : 'Flash through the chip ROM bootloader (UART or USB DFU)';
}

$('btn-flash').addEventListener('click', () => (TARGETS[$('target').value].stlink ? instantFlash() : openFlashDialog()));
$('btn-flash-more').addEventListener('click', () => openFlashDialog());

async function openFlashDialog() {
  const t = TARGETS[$('target').value];
  const img = await flashImage();
  if (!img) return;
  $('fd-what').textContent = `${$('project').selectedOptions[0].text} → ${t.name}`;
  $('fd-image').textContent = $('project').value === 'doom'
    ? `${kb(img.bytes.length)} from ${img.from} · Note: DOOM1.WAD (~4.2 MB) is stored separately on a FAT32 microSD card.`
    : `${kb(img.bytes.length)} from ${img.from}`;
  $('m-dfu').classList.toggle('disabled', !t.dfu);
  $('m-stlink').classList.toggle('disabled', !t.stlink);
  $(t.stlink ? 'm-stlink' : 'm-uart').querySelector('input').checked = true;
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
        flash(method, img.bytes, img.from);
        return;
      }
      file.arrayBuffer().then((buffer) => {
        const bytes = new Uint8Array(buffer);
        if (!bytes.length || bytes.length > t.flash) {
          showTerm('flash');
          line('flash', `Firmware image is ${kb(bytes.length)}; ${t.name} has ${kb(t.flash)} flash.`, 'err');
          return;
        }
        flash(method, bytes, file.name);
      }).catch((e) => {
        showTerm('flash');
        line('flash', `Could not read firmware image: ${e.message}`, 'err');
      });
    }
  };
}

$('custom-firmware').addEventListener('change', () => {
  const file = $('custom-firmware').files[0];
  if (file) $('fd-image').textContent = `${kb(file.size)} from rebuilt image ${file.name}`;
});

// Instant flash: one click on a Nucleo. The ST-Link halts the core over SWD,
// so there is no BOOT0 jumper or reset button, and the serial console (the
// probe's second USB function) keeps running or is connected afterwards.
async function instantFlash(image = null, from = '') {
  if (state.flashing) return;
  const t = TARGETS[$('target').value];
  showTerm('flash');
  if (!t.stlink) {
    line('flash', `Instant flash needs an ST-Link board; the ${t.name} is flashed through its ROM bootloader (▾).`, 'err');
    return;
  }
  if (!('usb' in navigator)) {
    line('flash', 'Instant flash uses WebUSB, which this browser does not have. Use Chrome or Edge.', 'err');
    return;
  }
  state.flashing = true;
  $('btn-flash').disabled = true;
  const t0 = performance.now();
  let st = null, ok = false;
  try {
    // Ask for the probe first, while the click still counts as a user gesture.
    let dev = (await navigator.usb.getDevices()).find(isStLink);
    if (!dev) {
      line('flash', 'Select "STM32 STLink" once; the browser remembers it and later flashes need no dialog.', 'dim');
      dev = await navigator.usb.requestDevice({ filters: STLINK_FILTERS });
    }
    if (!image) {
      const img = await flashImage();
      if (!img) return;
      ({ bytes: image, from } = img);
    }
    line('flash', `Instant flash: ${$('project').selectedOptions[0].text} → ${t.name}, ${kb(image.length)} from ${from}`);
    st = new StLink(dev, (s) => line('flash', s, 'dim'));
    const info = await st.connect();
    if (!t.stlink.includes(info.chipId)) {
      throw new Error(`this board is an ${info.chip}, not the ${t.name}; select the matching target`);
    }
    await st.flash(image, { onProgress: progress });
    ok = true;
    line('flash', `Flashed, verified and started ${kb(image.length)} in ${((performance.now() - t0) / 1000).toFixed(1)}s.`, 'ok');
  } catch (e) {
    line('flash', `Flash failed: ${e.message}`, 'err');
    if (e.name === 'NotFoundError') {
      line('flash', 'No ST-Link was chosen. Plug the Nucleo in with a data USB cable (CN1) and press Flash again.', 'dim');
    } else if (e.name === 'SecurityError' || /access denied|claim|unable to open|busy/i.test(e.message)) {
      line('flash', 'Another program is using the ST-Link: STM32CubeProgrammer/CubeIDE, st-flash/st-util, OpenOCD or this IDE in another tab. Close it and press Flash again.', 'dim');
    }
  } finally {
    if (st) await st.close();
    state.flashing = false;
    $('btn-flash').disabled = false;
    setTimeout(() => { $('flash-progress').hidden = true; }, 1500);
  }
  if (!ok) return;
  if (state.console) {
    showTerm('serial');
    return;
  }
  const port = await stlinkSerialPort();
  if (port && await openConsole(port, { quiet: true })) {
    line('flash', 'Serial console connected to the ST-Link USB serial port (USART2).', 'ok');
    showTerm('serial');
  } else if (!port) {
    line('flash', 'Press Connect serial and choose the STLink port once to see the board output (115200 8N1).', 'dim');
  }
}

async function flash(method, image, from) {
  if (method === 'stlink') return instantFlash(image, from);
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
  try { localStorage.setItem(TARGET_KEY, $('target').value); } catch { /* storage blocked */ }
  updateFlashButton();
  refreshProjectAvailability();
  renderMemory();
  if (sim.running) sim.stop(), $('btn-stop').disabled = true;
  updateEmulator();
  const project = projectInfo();
  const main = project?.entry || 'firmware/projects/blinky/main.c';
  $('example-name').textContent = project?.name || 'Firmware example';
  $('example-description').textContent = project?.description || '';
  $('example-targets').textContent = project?.targets.map((target) => target.toUpperCase()).join(' · ') || '';
  const hwNote = $('example-hardware-note');
  if (hwNote) {
    if (project?.hardwareNote) {
      hwNote.innerHTML = `<strong>Hardware requirement:</strong> ${project.hardwareNote}`;
      hwNote.hidden = false;
    } else {
      hwNote.textContent = '';
      hwNote.hidden = true;
    }
  }
  if (state.files.includes(main)) openFile(main);
}
$('target').addEventListener('change', () => {
  onSelection();
  if (!document.querySelector('.clock-pane').hidden) void clockDiagram.show({ target: $('target').value, readSource: sourceForSimulation });
});
$('project').addEventListener('change', onSelection);
document.addEventListener('clockpanechange', (event) => {
  if (event.detail?.open) void clockDiagram.show({ target: $('target').value, readSource: sourceForSimulation });
});

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); saveAll(); }
  if ((e.ctrlKey || e.metaKey) && e.key === 'b') { e.preventDefault(); build(); }
});
window.addEventListener('pagehide', () => {
  const changed = [...state.open.entries()].filter(([, file]) => !file.doc.isClean(file.saved));
  if (!changed.length) return;
  if (state.server) {
    for (const [path, file] of changed) {
      void fetch(`api/file?path=${encodeURIComponent(path)}`, { method: 'PUT', body: file.doc.getValue(), keepalive: true });
    }
    return;
  }
  const local = drafts(), modified = storedObject(MODIFIED_KEY);
  for (const [path, file] of changed) {
    const content = file.doc.getValue(); local[path] = content;
    const baseline = storedObject(BASELINE_KEY)[path];
    if (baseline === content) delete modified[path]; else modified[path] = true;
  }
  try { saveStoredObject(DRAFT_KEY, local); saveStoredObject(MODIFIED_KEY, modified); }
  catch { /* Keep the already autosaved draft if a final pagehide write exceeds quota. */ }
});

// Board choice: the last one used here, else the Nucleo when its ST-Link was
// allowed before. Plugging a known ST-Link in announces instant flash.
async function restoreTarget() {
  let saved = null;
  try { saved = localStorage.getItem(TARGET_KEY); } catch { /* storage blocked */ }
  if (saved && TARGETS[saved]) {
    $('target').value = saved;
  } else if ('usb' in navigator && (await navigator.usb.getDevices().catch(() => [])).some(isStLink)) {
    $('target').value = 'f401';
    line('flash', 'ST-Link found: selected the Nucleo-F401RE. Flash programs it over USB in one click.', 'ok');
  }
  if ('usb' in navigator) {
    navigator.usb.addEventListener('connect', (e) => {
      if (isStLink(e.device)) line('flash', 'ST-Link connected: instant flash ready.', 'ok');
    });
    navigator.usb.addEventListener('disconnect', (e) => {
      if (isStLink(e.device)) line('flash', 'ST-Link disconnected.', 'warn');
    });
  }
}

(async () => {
  await Promise.all([detectServer(), loadManifest(), loadProjectCatalog(), restoreTarget()]);
  await loadTree();
  for (const [path, text] of Object.entries(drafts())) syncModifiedFile(path, text);
  renderModifiedFiles();
  line('build', state.server
    ? 'Ready. Build runs arm-none-eabi-gcc on this machine (Ctrl+B).'
    : 'Static IDE ready: edit sources, build H743 or Nucleo-F401RE firmware in the browser, and flash over USB. Browser drafts stay on this device.', 'dim');
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
