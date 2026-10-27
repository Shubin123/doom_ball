#!/usr/bin/env node
// Sets up and tests the UVic Satellite Design DOOM balloon repositories that
// are checked out under uvsd/ as git submodules, with the same commands their
// own CI runs.
//
//   node tools/uvsd.mjs setup [repo...]   check out, fetch SDKs, install deps
//   node tools/uvsd.mjs test  [repo...]   build and test every checked-out repo
//   node tools/uvsd.mjs status            pinned commits and what is checked out
//
// Steps whose tools are missing (uv, cppcheck, arm-none-eabi-gcc, cmake, an
// SDK) are reported as SKIP with the reason; any FAIL makes the exit status 1.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEPS = path.join(ROOT, 'uvsd/.deps');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, 'uvsd/repos.json'), 'utf8'));

function which(name) {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (dir && fs.existsSync(path.join(dir, name))) return path.join(dir, name);
  }
  return null;
}
// Same search as server/forge_server.mjs and tests/run_all.sh.
function armToolchain() {
  if (process.env.ARM_GCC_PATH) return process.env.ARM_GCC_PATH;
  const onPath = which('arm-none-eabi-gcc');
  if (onPath) return path.dirname(onPath);
  const found = [];
  for (const base of [path.join(os.homedir(), '.local/toolchains'), '/opt', '/Applications/ArmGNUToolchain']) {
    if (!fs.existsSync(base)) continue;
    for (const name of fs.readdirSync(base)) {
      for (const bin of [path.join(base, name, 'bin'), path.join(base, name, 'arm-none-eabi/bin')]) {
        if (fs.existsSync(path.join(bin, 'arm-none-eabi-gcc'))) found.push(bin);
      }
    }
  }
  return found.sort().at(-1) || null;
}
const UV = which('uv') || [path.join(os.homedir(), '.local/bin/uv'), path.join(os.homedir(), '.cargo/bin/uv')].find((p) => fs.existsSync(p)) || null;
const ARM = armToolchain();
const PICO_SDK = process.env.PICO_SDK_PATH || path.join(DEPS, 'pico-sdk');
const NRF_SDK = process.env.NRF5_SDK_PATH || path.join(DEPS, 'nRF5_SDK_17.1.0');
// Where an SDK lives, relative to the checkout when it is inside it.
const shown = (dir) => (dir.startsWith(ROOT + path.sep) ? path.relative(ROOT, dir) : dir);
const env = { ...process.env, PATH: [ARM, process.env.PATH].filter(Boolean).join(path.delimiter), PICO_SDK_PATH: PICO_SDK };

function checkedOut(repo) {
  return fs.existsSync(path.join(ROOT, 'uvsd', repo.id, '.git'));
}
function run(cmd, args, cwd, extraEnv = {}) {
  const result = spawnSync(cmd, args, { cwd, env: { ...env, ...extraEnv }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { code: result.status ?? 1, out: `${result.stdout || ''}${result.stderr || ''}${result.error ? result.error.message : ''}` };
}

// Each step: [label, requirement check (returns a skip reason or null), command, args, cwd relative to the repo].
function steps(repo, phase) {
  const need = {
    uv: () => (UV ? null : 'uv is not installed (https://docs.astral.sh/uv/)'),
    cc: () => (which('cc') || which('gcc') ? null : 'no host C compiler'),
    cppcheck: () => (which('cppcheck') ? null : 'cppcheck is not installed'),
    arm: () => (ARM ? null : 'arm-none-eabi-gcc not found (PATH, ARM_GCC_PATH or ~/.local/toolchains)'),
    cmake: () => (which('cmake') ? null : 'cmake is not installed'),
    pico: () => (fs.existsSync(path.join(PICO_SDK, 'pico_sdk_init.cmake')) ? null : `Pico SDK not found (PICO_SDK_PATH or ${shown(PICO_SDK)}; run setup)`),
    node: () => (which('node') && which('npm') ? null : 'node and npm are not installed'),
    'arduino-cli': () => (which('arduino-cli') ? null : 'arduino-cli is not installed (brew install arduino-cli)'),
    shellcheck: () => (which('shellcheck') ? null : 'shellcheck is not installed (brew install shellcheck)'),
    'clang-format': () => (which('clang-format') ? null : 'clang-format is not installed (brew install clang-format)'),
    nrf: () => (fs.existsSync(path.join(NRF_SDK, 'modules/nrfx/nrfx.h')) ? null : `nRF5 SDK 17.1.0 not found (NRF5_SDK_PATH or ${shown(NRF_SDK)}; run setup)`),
  };
  const all = (...keys) => () => keys.map((k) => need[k]()).find(Boolean) || null;
  const book = MANIFEST.repos.find((r) => r.id === repo.id)?.[phase] || [];
  // {NRF_SDK}, {ARM} and {JOBS} in a manifest command expand to this machine's paths.
  const expand = (arg) => arg.replace('{NRF_SDK}', NRF_SDK).replace('{ARM}', ARM || '').replace('{JOBS}', String(os.cpus().length));
  return book.map((s) => [s.label, all(...(s.needs || [])), s.run[0] === 'uv' ? UV : s.run[0], s.run.slice(1).map(expand), s.cwd || '.', s.env || {}]);
}

function fetchShallow(url, ref, dest, submodules = []) {
  if (fs.existsSync(dest)) return { code: 0, out: 'already present' };
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  let r = run('git', ['clone', '-q', '--depth', '1', '-b', ref, url, dest], ROOT);
  for (const sub of submodules) if (r.code === 0) r = run('git', ['submodule', 'update', '-q', '--init', '--depth', '1', sub], dest);
  return r;
}

// The steps of uvsd-nrf-doom's setup.sh that the build needs, as its CI runs
// them (setup.sh also installs system packages with sudo): Nordic's SDK, two
// source fixes, and nrfx v2.4.0 in place of the SDK's copy.
function fetchNrf5Sdk() {
  if (fs.existsSync(path.join(NRF_SDK, 'modules/nrfx/nrfx.h'))) return { code: 0, out: 'already present' };
  const zip = path.join(DEPS, 'nRF5_SDK_17.1.0_ddde560.zip');
  const unpack = path.join(DEPS, 'nrf5-unpack');
  fs.mkdirSync(DEPS, { recursive: true });
  let r = fs.existsSync(zip) ? { code: 0 } : run('curl', ['--fail', '--location', '--silent', '--show-error', '-o', zip,
    'https://developer.nordicsemi.com/nRF5_SDK/nRF5_SDK_v17.x.x/nRF5_SDK_17.1.0_ddde560.zip'], ROOT);
  if (r.code) return r;
  fs.rmSync(unpack, { recursive: true, force: true });
  r = run('unzip', ['-q', zip, '-d', unpack], ROOT);
  if (r.code) return r;
  fs.rmSync(NRF_SDK, { recursive: true, force: true });
  fs.renameSync(path.join(unpack, 'nRF5_SDK_17.1.0_ddde560'), NRF_SDK);
  fs.rmSync(unpack, { recursive: true, force: true });
  const patch = (rel, from, to) => {
    const file = path.join(NRF_SDK, rel);
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').split(from).join(to));
  };
  patch('integration/nrfx/legacy/nrf_drv_spi.c', 'NRFX_SPIM_DEFAULT_CONFIG;',
    'NRFX_SPIM_DEFAULT_CONFIG(NRF_DRV_SPI_PIN_NOT_USED, NRF_DRV_SPI_PIN_NOT_USED, NRF_DRV_SPI_PIN_NOT_USED, NRF_DRV_SPI_PIN_NOT_USED);');
  patch('components/libraries/sdcard/app_sdcard.c', 'nrf_spi_frequency_t', 'nrf_spim_frequency_t');
  fs.rmSync(path.join(NRF_SDK, 'modules/nrfx'), { recursive: true, force: true });
  r = run('git', ['clone', '-q', '-c', 'advice.detachedHead=false', '--depth', '1', '-b', 'v2.4.0', 'https://github.com/NordicSemiconductor/nrfx.git', path.join(NRF_SDK, 'modules/nrfx')], ROOT);
  if (r.code === 0) fs.rmSync(zip, { force: true });
  return r;
}

const results = [];
function report(repo, label, status, detail = '') {
  results.push({ repo: repo.id, label, status });
  const line = `${status.padEnd(4)} ${repo.id}: ${label}${detail ? ` (${detail})` : ''}`;
  console.log(status === 'FAIL' ? `\x1b[31m${line}\x1b[0m` : status === 'SKIP' ? `\x1b[33m${line}\x1b[0m` : line);
}
// Hardware design repositories: every design and fabrication file is intact.
//   Altium .SchDoc/.PcbDoc/.SchLib/.PcbLib/.IntLib  OLE compound document
//   Altium ActiveBOM .BomDoc                         '|RECORD=' text
//   Gerber .gbr   ends with M02*; Altium's %TF.MD5 matches the file
//                 (MD5 of everything before it, line breaks removed)
//   .zip          unzip -t passes;  .step/.stp  ISO-10303-21 header
//   KiCad .kicad_sch/_pcb/_sym/_mod  balanced s-expression
// A Git LFS pointer, an HTML error page or a truncated download fails.
function checkHardware(dir) {
  const files = run('git', ['ls-files', '-z'], dir).out.split('\0').filter(Boolean);
  const OLE = Buffer.from('d0cf11e0a1b11ae1', 'hex');
  const bad = [], counts = {};
  const count = (kind) => { counts[kind] = (counts[kind] || 0) + 1; };
  for (const f of files) {
    const full = path.join(dir, f), ext = path.extname(f).toLowerCase();
    if (!fs.existsSync(full)) { bad.push(`${f} (missing)`); continue; }
    if (['.schdoc', '.pcbdoc', '.schlib', '.pcblib', '.intlib'].includes(ext)) {
      const head = Buffer.alloc(8), fd = fs.openSync(full, 'r');
      fs.readSync(fd, head, 0, 8, 0); fs.closeSync(fd);
      if (!head.equals(OLE)) bad.push(f); else count('Altium');
    } else if (ext === '.bomdoc') {
      if (!fs.readFileSync(full, 'latin1').startsWith('|RECORD=')) bad.push(f); else count('BOM');
    } else if (ext === '.gbr') {
      const text = fs.readFileSync(full, 'latin1');
      const md5 = text.match(/%TF\.MD5,([0-9a-f]{32})\*%/);
      const ok = /M02\*\s*$/.test(text) && (!md5 || crypto.createHash('md5').update(text.slice(0, md5.index).replace(/[\r\n]/g, ''), 'latin1').digest('hex') === md5[1]);
      if (!ok) bad.push(f); else count('Gerber');
    } else if (ext === '.zip') {
      if (run('unzip', ['-tqq', full], dir).code !== 0) bad.push(f); else count('zip');
    } else if (ext === '.step' || ext === '.stp') {
      if (!fs.readFileSync(full, 'latin1').slice(0, 64).includes('ISO-10303-21')) bad.push(f); else count('STEP');
    } else if (/^\.kicad_(sch|pcb|sym|mod)$/.test(ext)) {
      let depth = 0, inString = false, escaped = false, ok = true;
      for (const ch of fs.readFileSync(full, 'utf8')) {
        if (inString) { if (escaped) escaped = false; else if (ch === '\\') escaped = true; else if (ch === '"') inString = false; continue; }
        if (ch === '"') inString = true; else if (ch === '(') depth++; else if (ch === ')' && --depth < 0) ok = false;
      }
      if (!ok || depth !== 0) bad.push(f); else count('KiCad');
    } else if (fs.statSync(full).size < 200 && fs.readFileSync(full, 'latin1').startsWith('version https://git-lfs')) {
      bad.push(`${f} (LFS pointer)`);
    }
  }
  const summary = Object.entries(counts).map(([k, n]) => `${n} ${k}`).join(', ');
  if (!files.length) return { code: 0, out: 'the default branch has no files' };
  return { code: bad.length ? 1 : 0, out: bad.length ? `damaged: ${bad.slice(0, 8).join(', ')}${bad.length > 8 ? ` and ${bad.length - 8} more` : ''}` : `${files.length} files checked: ${summary || 'no design files'}` };
}
// Repositories of documents (CAD, notes): every tracked file is checked out
// with content, not left as a Git LFS pointer.
function checkFiles(dir) {
  const files = run('git', ['ls-files', '-z'], dir).out.split('\0').filter(Boolean);
  const pointers = files.filter((f) => {
    const full = path.join(dir, f);
    if (!fs.existsSync(full) || fs.statSync(full).size > 200) return false;
    return fs.readFileSync(full, 'latin1').startsWith('version https://git-lfs');
  });
  const missing = files.filter((f) => !fs.existsSync(path.join(dir, f)));
  return { code: files.length && !pointers.length && !missing.length ? 0 : 1,
    out: !files.length ? 'no files' : pointers.length || missing.length ? `LFS pointers: ${pointers.join(', ') || 'none'}; missing: ${missing.join(', ') || 'none'}` : `${files.length} files` };
}
function runSteps(repo, phase) {
  for (const [label, requirement, cmd, args, cwd, extraEnv] of steps(repo, phase)) {
    const missing = requirement();
    if (missing) { report(repo, label, 'SKIP', missing); continue; }
    if (cmd === 'hardware' || cmd === 'files') {
      const r = (cmd === 'hardware' ? checkHardware : checkFiles)(path.join(ROOT, 'uvsd', repo.id));
      report(repo, label, r.code === 0 ? 'PASS' : 'FAIL', r.out);
      continue;
    }
    const r = run(cmd, args, path.join(ROOT, 'uvsd', repo.id, cwd), extraEnv);
    report(repo, label, r.code === 0 ? 'PASS' : 'FAIL');
    if (r.code !== 0) console.log(r.out.trim().split('\n').slice(-25).map((l) => `     | ${l}`).join('\n'));
  }
}

function setup(repo) {
  if (!checkedOut(repo)) {
    // Private repositories are not checked out by default (update = none in
    // .gitmodules); --checkout fetches them when this account has access.
    const r = run('git', ['submodule', 'update', '--init', '--checkout', `uvsd/${repo.id}`], ROOT);
    if (r.code !== 0) {
      report(repo, 'check out', repo.private ? 'SKIP' : 'FAIL', repo.private ? 'private repository: no access from this account' : r.out.trim().split('\n').pop());
      return;
    }
    report(repo, 'check out', 'PASS');
  }
  if (repo.lfs) {
    const r = which('git-lfs') ? run('git', ['lfs', 'pull'], path.join(ROOT, 'uvsd', repo.id)) : null;
    report(repo, 'git lfs pull', r ? (r.code === 0 ? 'PASS' : 'FAIL') : 'SKIP', r ? '' : 'git-lfs is not installed');
  }
  if (repo.sdk === 'pico') {
    const r = fetchShallow('https://github.com/raspberrypi/pico-sdk.git', '2.3.1', PICO_SDK, ['lib/tinyusb']);
    report(repo, `Pico SDK 2.3.1 in ${shown(PICO_SDK)}`, r.code === 0 ? 'PASS' : 'FAIL');
  }
  if (repo.sdk === 'nrf5') {
    const r = fetchNrf5Sdk();
    report(repo, `nRF5 SDK 17.1.0 + nrfx v2.4.0 in ${shown(NRF_SDK)}`, r.code === 0 ? 'PASS' : 'FAIL');
    if (r.code !== 0) console.log(r.out.trim().split('\n').slice(-15).map((l) => `     | ${l}`).join('\n'));
  }
  runSteps(repo, 'setup');
}

function status() {
  const pins = run('git', ['submodule', 'status'], ROOT).out;
  for (const repo of MANIFEST.repos) {
    const line = pins.split('\n').find((l) => l.includes(`uvsd/${repo.id}`)) || '';
    const sha = (line.match(/[0-9a-f]{40}/) || ['?'])[0].slice(0, 7);
    const state = checkedOut(repo) ? (line.startsWith('+') ? 'checked out, differs from pin' : 'checked out') : 'not checked out';
    console.log(`${repo.id.padEnd(22)} ${sha}  ${state.padEnd(30)} ${repo.role}`);
  }
}

const [command = 'status', ...only] = process.argv.slice(2);
const repos = MANIFEST.repos.filter((r) => !only.length || only.includes(r.id));
if (command === 'status') status();
else if (command === 'setup') for (const repo of repos) setup(repo);
else if (command === 'test') {
  for (const repo of repos) {
    if (!checkedOut(repo)) { report(repo, 'checked out', repo.private ? 'SKIP' : 'FAIL', repo.private ? 'private repository not checked out' : 'run node tools/uvsd.mjs setup'); continue; }
    runSteps(repo, 'test');
  }
} else {
  console.error('usage: node tools/uvsd.mjs setup|test|status [repo...]');
  process.exit(2);
}
if (command !== 'status') {
  const count = (s) => results.filter((r) => r.status === s).length;
  console.log(`\n${count('PASS')} passed, ${count('FAIL')} failed, ${count('SKIP')} skipped`);
  process.exit(count('FAIL') ? 1 : 0);
}
