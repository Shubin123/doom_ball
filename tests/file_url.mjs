// Opens index.html straight from disk (file://) in headless Chrome, with
// default security settings, presses Run and checks DOOM renders frames.
// Usage: node tests/file_url.mjs [/path/to/chrome]
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const chrome = process.argv[2] || process.env.CHROME || 'google-chrome-stable';
const profile = mkdtempSync(path.join(tmpdir(), 'forge-chrome-'));
const port = 9300 + Math.floor(Math.random() * 500);
const proc = spawn(chrome, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--disable-gpu', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let result = 1;
try {
  let target;
  for (let i = 0; i < 50 && !target; i++) {
    await sleep(200);
    try {
      target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page');
    } catch { /* not up yet */ }
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  let id = 0;
  const pending = new Map();
  const errors = [];
  ws.addEventListener('message', (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) pending.get(msg.id)(msg.result);
    if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
  });
  const send = (method, params = {}) => new Promise((r) => { pending.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
  const evaluate = async (expr) => (await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })).result.value;

  await send('Runtime.enable');
  await send('Page.navigate', { url: pathToFileURL(path.join(root, 'index.html')).href });
  await sleep(3000);
  await evaluate(`document.getElementById('btn-run').click()`);
  await sleep(8000);
  const state = await evaluate(`({ href: location.protocol, fps: document.getElementById('emu-fps').textContent,
    overlay: document.getElementById('emu-overlay').hidden ? '' : document.getElementById('emu-overlay').innerText,
    memory: document.getElementById('memory').innerText.split('\\n')[0] })`);
  console.log(JSON.stringify({ ...state, errors }));
  result = state.href === 'file:' && /\d+ fps/.test(state.fps) && !state.overlay && errors.length === 0 ? 0 : 1;
  ws.close();
} catch (e) {
  console.error(e);
} finally {
  proc.kill();
  await sleep(300);
  rmSync(profile, { recursive: true, force: true });
}
process.exit(result);
