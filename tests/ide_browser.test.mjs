import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const chrome = process.env.CHROME || ['/usr/bin/google-chrome-stable','/usr/bin/google-chrome','/usr/bin/chromium'].find(existsSync);

test('static IDE runs C source on virtual HAL and search opens real source matches', { skip: !chrome }, async () => {
  const profile = mkdtempSync(path.join(tmpdir(), 'forge-static-chrome-'));
  const server = createServer((req, res) => {
    let pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (pathname === '/') pathname = '/index.html';
    const filename = path.resolve(root, `.${pathname}`);
    if (!filename.startsWith(root + path.sep) && filename !== path.join(root, 'index.html')) { res.writeHead(403).end(); return; }
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
    for (let attempt = 0; attempt < 80 && !page; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      try { page = (await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json()).find((item) => item.type === 'page'); } catch {}
    }
    assert.ok(page, 'Chrome DevTools page became available');
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once:true }); ws.addEventListener('error', reject, { once:true }); });
    let nextId = 0;
    const pending = new Map(), errors = [];
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
      if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
    });
    const send = (method, params = {}) => new Promise((resolve) => { const id = ++nextId; pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })); });
    const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise:true, returnByValue:true })).result?.result?.value;
    const waitFor = async (expression, timeout = 10000) => {
      const end = Date.now() + timeout;
      while (Date.now() < end) { const value = await evaluate(expression); if (value) return value; await new Promise((resolve) => setTimeout(resolve, 30)); }
      throw new Error(`Timed out waiting for browser expression: ${expression}`);
    };
    await send('Runtime.enable');
    await send('Page.enable');
    await send('Page.navigate', { url:`http://127.0.0.1:${port}/` });
    await waitFor(`document.readyState === 'complete' && document.querySelector('#project')?.options.length > 0`);
    await evaluate(`(() => { const p=document.querySelector('#project'); p.value='button-led'; p.dispatchEvent(new Event('change',{bubbles:true})); return true; })()`);
    await waitFor(`document.querySelector('#preview-log')?.textContent.includes('press PE4')`);
    await evaluate(`document.querySelector('#preview-button').click()`);
    await waitFor(`document.querySelector('#preview-log')?.textContent.includes('button press')`);
    assert.equal(await evaluate(`document.querySelector('#preview-led').classList.contains('on')`), true);
    await evaluate(`(() => { document.querySelector('#source-search-query').value='HAL_GPIO_(ReadPin|TogglePin)'; document.querySelector('#source-search-regex').checked=true; document.querySelector('#source-search-form').requestSubmit(); return true; })()`);
    await waitFor(`document.querySelector('#source-search-results')?.textContent.includes('firmware/projects/button-led/main.c:')`);
    await evaluate(`([...document.querySelectorAll('.search-result')].find(x=>x.textContent.includes('firmware/projects/button-led/main.c:'))).click()`);
    await waitFor(`document.querySelector('.editor-tab.active')?.title === 'firmware/projects/button-led/main.c'`);
    assert.deepEqual(errors, []);
  } finally {
    ws?.close(); proc.kill(); server.close();
    await new Promise((resolve) => setTimeout(resolve, 150));
    rmSync(profile, { recursive:true, force:true });
  }
});
