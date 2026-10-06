// Headless-Chrome harness for the static IDE, shared by the browser tests.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const chrome = process.env.CHROME || ['/usr/bin/google-chrome-stable','/usr/bin/google-chrome','/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(existsSync);

// Serves the checkout, opens the static IDE in headless Chrome and hands the
// test a DevTools evaluate / waitFor pair, the uncaught page errors and every
// URL the page requested. `before` is page script that runs ahead of the
// IDE's own (fake Web Serial / WebUSB devices the IDE finds when it starts).
// `bindings` maps window function names to Node handlers: the page calls
// name(string) and handler(string, evaluate) runs here. `site: 'docs'` serves
// the published GitHub Pages tree, which also carries the browser compiler.
export async function withStaticIde(run, { before = null, bindings = {}, site = null } = {}) {
  const served = site ? path.join(root, site) : root;
  const profile = mkdtempSync(path.join(tmpdir(), 'forge-static-chrome-'));
  const server = createServer((req, res) => {
    let pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (pathname === '/') pathname = '/index.html';
    // The fake-device simulators live in tests/, outside the published tree.
    const base = pathname.startsWith('/tests/') ? root : served;
    const filename = path.resolve(base, `.${pathname}`);
    if (!filename.startsWith(base + path.sep)) { res.writeHead(403).end(); return; }
    const types = { '.html':'text/html', '.js':'text/javascript', '.mjs':'text/javascript', '.css':'text/css', '.json':'application/json', '.wasm':'application/wasm', '.wad':'application/octet-stream' };
    res.setHeader('Content-Type', types[path.extname(filename)] || 'application/octet-stream');
    const stream = createReadStream(filename);
    stream.on('error', () => { res.writeHead(404).end(); });
    stream.pipe(res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const debugPort = 20000 + Math.floor(Math.random() * 30000);
  const proc = spawn(chrome, ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run',
    `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio:'ignore' });
  let ws;
  try {
    let page;
    for (let attempt = 0; attempt < 300 && !page; attempt++) {   // up to 30 s on a loaded machine
      await new Promise((resolve) => setTimeout(resolve, 100));
      try { page = (await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json()).find((item) => item.type === 'page'); } catch {}
    }
    assert.ok(page, 'Chrome DevTools page became available');
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once:true }); ws.addEventListener('error', reject, { once:true }); });
    let nextId = 0;
    const pending = new Map(), errors = [], requests = [];
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
      if (message.method === 'Network.requestWillBeSent') requests.push(message.params.request.url);
      if (message.method === 'Runtime.bindingCalled' && bindings[message.params.name]) {
        bindings[message.params.name](message.params.payload, evaluate);
      }
      if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
    });
    // Every DevTools call fails instead of hanging if Chrome stops answering.
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Chrome did not answer ${method} within 60 s`)); }, 60000);
      pending.set(id, (message) => { clearTimeout(timer); resolve(message); });
      ws.send(JSON.stringify({ id, method, params }));
    });
    ws.addEventListener('close', () => {
      for (const [id, done] of pending) { pending.delete(id); done({ id, error: { message: 'Chrome DevTools connection closed' } }); }
    });
    const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise:true, returnByValue:true })).result?.result?.value;
    const waitFor = async (expression, timeout = 10000) => {
      const end = Date.now() + timeout;
      while (Date.now() < end) { const value = await evaluate(expression); if (value) return value; await new Promise((resolve) => setTimeout(resolve, 30)); }
      throw new Error(`Timed out waiting for browser expression: ${expression}`);
    };
    await send('Runtime.enable');
    await send('Network.enable');
    await send('Page.enable');
    for (const name of Object.keys(bindings)) await send('Runtime.addBinding', { name });
    if (before) await send('Page.addScriptToEvaluateOnNewDocument', { source: before });
    // Attach a local file to an <input type=file>, as if the user picked it.
    const setFiles = async (selector, files) => {
      const { result: { root: doc } } = await send('DOM.getDocument');
      const { result: { nodeId } } = await send('DOM.querySelector', { nodeId: doc.nodeId, selector });
      await send('DOM.setFileInputFiles', { nodeId, files });
    };
    await send('Page.navigate', { url:`http://127.0.0.1:${port}/` });
    await waitFor(`document.readyState === 'complete' && document.querySelector('#project')?.options.length > 0`);
    await run({ send, evaluate, waitFor, errors, requests, setFiles, port });
  } finally {
    ws?.close(); proc.kill('SIGKILL'); server.close();
    await new Promise((resolve) => setTimeout(resolve, 150));
    rmSync(profile, { recursive:true, force:true, maxRetries:10, retryDelay:100 });
  }
}
