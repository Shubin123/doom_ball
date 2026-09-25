#!/usr/bin/env node
// Local STM32 Forge API and static server. Requires Node.js and arm-none-eabi-gcc.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 8732);
const TARGETS = {
  h743: { name: 'STM32H743IITx', core: 'Cortex-M7 @ 400 MHz', flash: 2097152, ram: 1048576 },
  bluepill: { name: 'STM32F103C8T6 (Blue Pill)', core: 'Cortex-M3 @ 72 MHz', flash: 65536, ram: 20480 },
};
const PROJECTS = JSON.parse(fs.readFileSync(path.join(ROOT, 'firmware/projects/catalog.json'), 'utf8'))
  .projects.map((project) => project.id);
const EDITABLE = [];
for (const base of ['firmware/projects', 'firmware/targets', 'firmware/third_party', 'engine/platform', 'engine/doomgeneric']) {
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (/\.(c|h|s|ld|mk)$/.test(entry.name) || entry.name === 'Makefile') EDITABLE.push(rel);
    }
  };
  walk(base);
}
EDITABLE.push('firmware/Makefile');
EDITABLE.sort();
const editableSet = new Set(EDITABLE);
let building = false;

function toolchainDir() {
  if (process.env.ARM_GCC_PATH) return process.env.ARM_GCC_PATH;
  const onPath = (process.env.PATH || '').split(path.delimiter)
    .find((dir) => fs.existsSync(path.join(dir, 'arm-none-eabi-gcc')));
  if (onPath) return onPath;
  const candidates = [];
  for (const root of [path.join(os.homedir(), '.local/toolchains'), '/opt']) {
    if (!fs.existsSync(root)) continue;
    for (const name of fs.readdirSync(root)) {
      const dir = path.join(root, name, 'bin');
      if (fs.existsSync(path.join(dir, 'arm-none-eabi-gcc'))) candidates.push(dir);
    }
  }
  return candidates.sort().at(-1) || null;
}

function json(res, status, value) {
  const data = Buffer.from(JSON.stringify(value));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': data.length, 'cache-control': 'no-store' });
  res.end(data);
}
function body(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function filePath(rel) {
  const full = path.resolve(ROOT, rel);
  if (!full.startsWith(ROOT + path.sep) || !editableSet.has(rel)) return null;
  return full;
}
function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: ROOT, ...options });
    let stdout = '', stderr = '';
    child.stdout?.on('data', (b) => { stdout += b; });
    child.stderr?.on('data', (b) => { stderr += b; });
    child.on('error', (e) => resolve({ code: 127, stdout, stderr: `${stderr}${e.message}\n` }));
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}
function parseMemory(log) {
  const rows = [];
  const unit = { B: 1, KB: 1024, MB: 1048576, GB: 1073741824 };
  for (const line of log.split(/\r?\n/)) {
    const m = line.match(/^\s*(\w+):\s+(\d+(?:\.\d+)?)\s*([KMG]?B)\s+(\d+(?:\.\d+)?)\s*([KMG]?B)\s+/);
    if (m && m[1] !== 'Memory') rows.push({ region: m[1], used: Math.round(Number(m[2]) * unit[m[3]]), size: Math.round(Number(m[4]) * unit[m[5]]), overflow: 0 });
  }
  for (const m of log.matchAll(/region [`'](\w+)' overflowed by (\d+) bytes/g)) {
    const r = rows.find((row) => row.region === m[1]);
    if (r) r.overflow = Number(m[2]);
  }
  return rows;
}
async function handleBuild(req, res) {
  if (building) return json(res, 409, { ok: false, log: 'A build is already running.\n', memory: [] });
  let input;
  try { input = JSON.parse((await body(req)).toString('utf8')); }
  catch { return json(res, 400, { error: 'invalid JSON' }); }
  const { target, project } = input;
  if (!Object.hasOwn(TARGETS, target) || !PROJECTS.includes(project)) return json(res, 400, { error: 'unsupported target or project' });
  building = true;
  try {
    const args = ['-C', path.join(ROOT, 'firmware'), `-j${os.cpus().length}`, `TARGET=${target}`, `PROJECT=${project}`];
    const gccPath = toolchainDir();
    const output = path.join(ROOT, 'firmware/build', `${target}-${project}`);
    for (const name of ['firmware.elf', 'firmware.bin', 'firmware.hex']) {
      try { fs.unlinkSync(path.join(output, name)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    const result = await run('make', args, { env: { ...process.env, ...(gccPath ? { ARM_GCC_PATH: gccPath } : {}) } });
    const log = result.stdout + result.stderr;
    const answer = { ok: result.code === 0, toolchain: '', command: `make ${args.slice(3).join(' ')}`, log, memory: parseMemory(log) };
    if (answer.ok) {
      const binary = fs.readFileSync(path.join(output, 'firmware.bin'));
      answer.binary = binary.toString('base64');
      answer.binarySize = binary.length;
      const nmPath = gccPath ? path.join(gccPath, 'arm-none-eabi-nm') : 'arm-none-eabi-nm';
      const nm = await run(nmPath, [path.join(output, 'firmware.elf')]);
      const symbols = new Map();
      for (const line of nm.stdout.split(/\r?\n/)) {
        const m = line.match(/^([0-9a-fA-F]+)\s+\w\s+(__zone\d_(?:start|end))$/);
        if (m) symbols.set(m[2], parseInt(m[1], 16));
      }
      const banks = [];
      for (let i = 0; symbols.has(`__zone${i}_start`) && symbols.has(`__zone${i}_end`); i++) banks.push(symbols.get(`__zone${i}_end`) - symbols.get(`__zone${i}_start`));
      answer.zoneBanks = banks.length ? banks : null;
      answer.zone = banks.length ? banks.reduce((a, b) => a + b, 0) : null;
    }
    return json(res, 200, answer);
  } finally { building = false; }
}

const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.wad': 'application/octet-stream', '.bin': 'application/octet-stream', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname === '/api/status' && req.method === 'GET') {
      const binDir = toolchainDir();
      const gcc = binDir ? path.join(binDir, 'arm-none-eabi-gcc') : 'arm-none-eabi-gcc';
      const v = await run(gcc, ['--version']);
      return json(res, 200, { toolchain: v.code ? null : v.stdout.split(/\r?\n/)[0], toolchainPath: binDir, targets: TARGETS, projects: PROJECTS });
    }
    if (url.pathname === '/api/tree' && req.method === 'GET') return json(res, 200, { files: EDITABLE });
    if (url.pathname === '/api/file') {
      const rel = url.searchParams.get('path') || '';
      const full = filePath(rel);
      if (!full || !fs.existsSync(full)) return json(res, 404, { error: 'not found' });
      if (req.method === 'GET') return json(res, 200, { path: rel, content: fs.readFileSync(full, 'utf8') });
      if (req.method === 'PUT') {
        fs.writeFileSync(full, await body(req));
        return json(res, 200, { ok: true });
      }
      return json(res, 405, { error: 'method not allowed' });
    }
    if (url.pathname === '/api/build' && req.method === 'POST') return await handleBuild(req, res);
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
    let rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
    let full = path.resolve(ROOT, rel);
    if (!full.startsWith(ROOT + path.sep) || !fs.existsSync(full) || !fs.statSync(full).isFile()) { res.writeHead(404).end('Not found'); return; }
    const stat = fs.statSync(full);
    res.writeHead(200, { 'content-type': `${MIME[path.extname(full)] || 'application/octet-stream'}; charset=utf-8`, 'content-length': stat.size, 'cache-control': 'no-store' });
    if (req.method === 'HEAD') res.end(); else fs.createReadStream(full).pipe(res);
  } catch (e) {
    if (!res.headersSent) json(res, 500, { error: e.message }); else res.destroy(e);
  }
});
server.listen(PORT, '127.0.0.1', () => console.log(`STM32 Forge at http://localhost:${PORT}/`));
