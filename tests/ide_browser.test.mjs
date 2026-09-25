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
    assert.equal(await evaluate(`document.querySelector('#btn-save') === null`), true);
    await evaluate(`(() => { const cm=document.querySelector('.CodeMirror').CodeMirror; cm.setValue(cm.getValue()+'\\n// autosave verification\\n'); return true; })()`);
    await waitFor(`JSON.parse(localStorage.getItem('stm32-forge-drafts-v1')||'{}')['firmware/projects/button-led/main.c']?.includes('autosave verification')`);
    await waitFor(`document.querySelector('#modified-warning')?.textContent.includes('firmware/projects/button-led/main.c')`);
    await evaluate(`document.querySelector('#btn-reset-samples').click()`);
    assert.equal(await evaluate(`document.querySelector('#reset-dialog').open`), true);
    assert.equal(await evaluate(`document.querySelector('#reset-file-list').textContent.includes('firmware/projects/button-led/main.c')`), true);
    await evaluate(`document.querySelector('#confirm-reset-samples').click()`);
    await waitFor(`document.querySelector('#modified-warning').hidden`);
    assert.equal(await evaluate(`JSON.parse(localStorage.getItem('stm32-forge-drafts-v1')||'{}')['firmware/projects/button-led/main.c']`), undefined);
    const beforeDockedDrag = await evaluate(`document.querySelector('.files').getBoundingClientRect().left`);
    const headerPoint = await evaluate(`(() => { const r=document.querySelector('.files .panel-head').getBoundingClientRect(); return {x:r.left+Math.min(20,r.width/2),y:r.top+r.height/2}; })()`);
    await send('Input.dispatchMouseEvent', { type:'mousePressed', x:headerPoint.x, y:headerPoint.y, button:'left', buttons:1 });
    await send('Input.dispatchMouseEvent', { type:'mouseMoved', x:headerPoint.x+45, y:headerPoint.y+28, button:'left', buttons:1 });
    await send('Input.dispatchMouseEvent', { type:'mouseReleased', x:headerPoint.x+45, y:headerPoint.y+28, button:'left', buttons:0 });
    assert.equal(await evaluate(`document.querySelector('.files').classList.contains('floating')`), true);
    assert.equal(await evaluate(`Math.abs(parseInt(document.querySelector('.files').style.left,10) - (${beforeDockedDrag} + 45)) < 2`), true);
    assert.equal(await evaluate(`getComputedStyle(document.querySelector('.files')).resize`), 'both');
    await evaluate(`document.querySelector('.files .pane-toggle').click()`);
    assert.equal(await evaluate(`document.querySelector('.files').classList.contains('floating')`), false);
    await evaluate(`document.querySelector('.editor .pane-toggle').click()`);
    assert.equal(await evaluate(`document.querySelector('.editor').classList.contains('floating')`), true);
    assert.equal(await evaluate(`document.querySelector('.editor-tab.active')?.title`), 'firmware/projects/button-led/main.c');
    await evaluate(`document.querySelector('.editor .pane-toggle').click()`);
    assert.equal(await evaluate(`document.querySelector('.bottom .pane-toggle')?.textContent`), 'Float');
    await evaluate(`(() => { const p=document.querySelector('#project'); p.value='freertos'; p.dispatchEvent(new Event('change',{bubbles:true})); return true; })()`);
    await waitFor(`document.querySelector('#preview-log')?.textContent.includes('[LED task] heartbeat') && document.querySelector('#preview-log')?.textContent.includes('[monitor task] tick')`, 10000);
    await waitFor(`document.querySelector('#preview-rtos')?.hidden === false && [...document.querySelectorAll('.rtos-task')].length === 2`);
    assert.equal(await evaluate(`[...document.querySelectorAll('.rtos-task')].every(row => ['LED','Monitor'].includes(row.dataset.taskName))`), true);
    await evaluate(`document.querySelector('#btn-clock').click()`);
    await waitFor(`document.querySelector('#clock-diagram .clock-node.primary')?.textContent.includes('400.00 MHz')`);
    assert.equal(await evaluate(`document.querySelector('.clock-pane').classList.contains('floating')`), true);
    assert.equal(await evaluate(`document.querySelector('#clock-diagram').textContent.includes('HCLK 200.00 MHz')`), true);
    assert.equal(await evaluate(`document.querySelector('#clock-diagram').textContent.includes('PCLK 100.00 MHz')`), true);
    await evaluate(`document.querySelector('#btn-clock').click()`);
    assert.equal(await evaluate(`document.querySelector('.clock-pane').hidden`), true);
    if (process.env.FORGE_TEST_WASM_BUILD === '1') {
      await evaluate(`document.querySelector('#btn-build').click()`);
      await waitFor(`document.querySelector('#term-build')?.textContent.includes('Build succeeded') || document.querySelector('#term-build')?.textContent.includes('Build failed')`, 180000);
      assert.equal(await evaluate(`document.querySelector('#term-build').textContent.includes('Build succeeded')`), true, await evaluate(`document.querySelector('#term-build').textContent`));
    }
    assert.deepEqual(errors, []);
  } finally {
    ws?.close(); proc.kill(); server.close();
    await new Promise((resolve) => setTimeout(resolve, 150));
    rmSync(profile, { recursive:true, force:true });
  }
});
