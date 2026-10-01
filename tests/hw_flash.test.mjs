// Hardware-in-the-loop flashing tests: a real ST-Link and the STM32 behind it.
// Opt in with FORGE_HW=1; needs the Node `usb` package (`npm i --no-save usb`
// in the checkout, or FORGE_USB_MODULE=/path/to/node_modules/usb) and no
// other program using the probe. The board is identified over SWD and its
// matching target is used: STM32H743 (`h743`) or Nucleo-F401RE (`f401`).
//
// 1. ide/flash/stlink.js programs Blinky straight from Node; the flash is read
//    back and the LED pin is watched toggling.
// 2. The static IDE in headless Chrome, with navigator.usb bridged to the real
//    probe over a DevTools binding, flashes DOOM (H743) and then Blinky by
//    pressing its Flash button; each image is read back afterwards.
// The board is left running Blinky.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StLink, isStLink } from '../ide/flash/stlink.js';
import { chrome, withStaticIde } from './chrome_ide.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BOARDS = {
  0x450: { target: 'h743', images: ['doom', 'blinky'], led: { odr: 0x58020814, bit: 13, name: 'PC13' } },
  0x433: { target: 'f401', images: ['blinky'], led: { odr: 0x40020014, bit: 5, name: 'PA5 (LD2)' } },
  0x423: { target: 'f401', images: ['blinky'], led: { odr: 0x40020014, bit: 5, name: 'PA5 (LD2)' } },
};
const prebuilt = (target, project) => new Uint8Array(readFileSync(path.join(root, `firmware/prebuilt/${target}-${project}.bin`)));

let probe = null, why = 'set FORGE_HW=1 to run against a connected ST-Link';
if (process.env.FORGE_HW === '1') {
  try {
    const { WebUSB } = await import(process.env.FORGE_USB_MODULE || 'usb');
    const usb = new WebUSB({ allowAllDevices: true });
    probe = { usb, find: async () => (await usb.getDevices()).find(isStLink) };
    if (!await probe.find()) { probe = null; why = 'no ST-Link connected'; }
  } catch (e) {
    why = `Node usb package not available (${e.message})`;
  }
}

// Opens the probe, runs fn(stlink, info) and always releases it.
async function withProbe(fn) {
  const st = new StLink(await probe.find(), () => {});
  try { return await fn(st, await st.connect()); } finally { await st.close(); }
}

async function readBack(length) {
  return withProbe((st) => st.readMem(0x08000000, (length + 3) & ~3));
}

// Samples the LED's output bit over SWD without halting the core.
async function ledToggles(led, ms = 7000) {
  return withProbe(async (st) => {
    const seen = new Set();
    for (const end = Date.now() + ms; Date.now() < end && seen.size < 2;) {
      seen.add(((await st.read32(led.odr)) >>> led.bit) & 1);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return seen.size === 2;
  });
}

test('real ST-Link: stlink.js flashes Blinky, reads it back, the LED blinks', { skip: probe ? false : why, timeout: 120000 }, async () => {
  const info = await withProbe(async (st, i) => i);
  const board = BOARDS[info.chipId];
  assert.ok(board, `no target for chip 0x${info.chipId.toString(16)} (${info.chip})`);
  const image = prebuilt(board.target, 'blinky');
  const phases = [];
  await withProbe((st) => st.flash(image, { onProgress: (p) => { if (phases.at(-1) !== p) phases.push(p); } }));
  assert.deepEqual(phases, ['erase', 'write', 'verify']);
  assert.deepEqual((await readBack(image.length)).subarray(0, image.length), image);
  assert.ok(await ledToggles(board.led), `${board.led.name} toggles`);
});

// navigator.usb in the page, backed by the real device in this process.
function bridgeScript(dev, target) {
  return `(() => {
    localStorage.setItem('stm32-forge-target', ${JSON.stringify(target)});
    let seq = 0;
    const waiting = new Map();
    window.__usbReply = (id, ok, value) => {
      const w = waiting.get(id); waiting.delete(id);
      if (ok) w.resolve(value); else w.reject(Object.assign(new Error(value.message), { name: value.name }));
    };
    const call = (method, ...args) => new Promise((resolve, reject) => {
      const id = ++seq; waiting.set(id, { resolve, reject });
      window.usbCall(JSON.stringify({ id, method, args }));
    });
    const toB64 = (u8) => { let s = ''; for (const b of u8) s += String.fromCharCode(b); return btoa(s); };
    const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
    const dev = {
      vendorId: ${dev.vendorId}, productId: ${dev.productId}, productName: ${JSON.stringify(dev.productName || '')},
      opened: false, configuration: null, transfers: 0,
      async open() { await call('open'); this.opened = true; },
      async close() { await call('close'); this.opened = false; },
      async selectConfiguration(n) { this.configuration = await call('selectConfiguration', n); },
      claimInterface: (n) => call('claimInterface', n),
      releaseInterface: (n) => call('releaseInterface', n),
      async transferOut(ep, data) {
        this.transfers++;
        const u8 = data instanceof Uint8Array ? data : new Uint8Array(data.buffer || data, data.byteOffset || 0, data.byteLength);
        return call('transferOut', ep, toB64(u8));
      },
      async transferIn(ep, length) {
        this.transfers++;
        const r = await call('transferIn', ep, length);
        return { status: r.status, data: new DataView(fromB64(r.data).buffer) };
      },
    };
    window.realProbe = dev;
    const usb = new EventTarget();
    usb.getDevices = async () => [dev];
    usb.requestDevice = async () => dev;
    Object.defineProperty(navigator, 'usb', { value: usb, configurable: true });
  })();`;
}

function usbHandler(dev) {
  const methods = {
    open: () => dev.opened ? null : dev.open(),
    close: () => dev.close(),
    async selectConfiguration(n) {
      if (!dev.configuration) await dev.selectConfiguration(n);
      return { interfaces: dev.configuration.interfaces.map((i) => ({ interfaceNumber: i.interfaceNumber,
        alternates: i.alternates.map((a) => ({ interfaceClass: a.interfaceClass,
          endpoints: a.endpoints.map((e) => ({ endpointNumber: e.endpointNumber, direction: e.direction, type: e.type })) })) })) };
    },
    claimInterface: (n) => dev.claimInterface(n),
    releaseInterface: (n) => dev.releaseInterface(n),
    async transferOut(ep, b64) { const r = await dev.transferOut(ep, Buffer.from(b64, 'base64')); return { status: r.status }; },
    async transferIn(ep, length) {
      const r = await dev.transferIn(ep, length);
      return { status: r.status, data: Buffer.from(r.data.buffer, r.data.byteOffset, r.data.byteLength).toString('base64') };
    },
  };
  return async (payload, evaluate) => {
    const { id, method, args } = JSON.parse(payload);
    let reply;
    try {
      reply = [true, (await methods[method](...args)) ?? null];
    } catch (e) {
      reply = [false, { name: e.name, message: e.message }];
    }
    await evaluate(`__usbReply(${id}, ${reply[0]}, ${JSON.stringify(reply[1])})`);
  };
}

test('real ST-Link: the IDE Flash button programs the board through WebUSB', { skip: !probe ? why : !chrome ? 'no Chrome' : false, timeout: 300000 }, async () => {
  const info = await withProbe(async (st, i) => i);
  const board = BOARDS[info.chipId];
  assert.ok(board, `no target for chip 0x${info.chipId.toString(16)} (${info.chip})`);
  const dev = await probe.find();
  await withStaticIde(async ({ evaluate, waitFor, errors }) => {
    assert.equal(await evaluate(`document.querySelector('#target').value`), board.target);
    assert.equal(await evaluate(`document.querySelector('#btn-flash').textContent`), 'Flash');
    for (const project of board.images) {
      const image = prebuilt(board.target, project);
      await evaluate(`(() => { const p = document.querySelector('#project'); p.value = '${project}'; p.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
      await waitFor(`!document.querySelector('#btn-flash').disabled`);
      const start = (await evaluate(`document.querySelector('#term-flash').textContent`)).length;
      await evaluate(`document.querySelector('#btn-flash').click()`);
      await waitFor(`/Flashed, verified|Flash failed/.test(document.querySelector('#term-flash').textContent.slice(${start}))`, 240000);
      const log = (await evaluate(`document.querySelector('#term-flash').textContent`)).slice(start);
      assert.match(log, new RegExp(`${info.chip.replace(/[/()]/g, '\\$&')} \\(id 0x${info.chipId.toString(16)}\\)`), log);
      assert.match(log, /Flashed, verified and started/, log);
      await waitFor(`!document.querySelector('#btn-flash').disabled`);
      assert.equal(await evaluate(`realProbe.opened`), false, 'the IDE released the probe');
      assert.deepEqual((await readBack(image.length)).subarray(0, image.length), image, `${project} read back from the board`);
      console.log(`# ${board.target}-${project}: ${image.length} bytes, ${log.match(/in ([\d.]+)s/)[1]} s, ${await evaluate('realProbe.transfers')} USB transfers so far`);
    }
    assert.deepEqual(errors, []);
  }, { before: bridgeScript(dev, board.target), bindings: { usbCall: usbHandler(dev) } });
  assert.ok(await ledToggles(board.led), `${board.led.name} toggles after the IDE flashed Blinky`);
});
