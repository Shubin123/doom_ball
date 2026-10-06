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
// hz: the core clock Blinky configures (H743 400 MHz, F401 84 MHz); f4: the
// STM32F4 RCC / flash / USART2 registers are decoded as well.
const BOARDS = {
  0x450: { target: 'h743', images: ['doom', 'blinky'], hz: 400e6, led: { odr: 0x58020814, bit: 13, name: 'PC13' } },
  0x433: { target: 'f401', images: ['blinky'], hz: 84e6, f4: true, led: { odr: 0x40020014, bit: 5, name: 'PA5 (LD2)' } },
  0x423: { target: 'f401', images: ['blinky'], hz: 84e6, f4: true, led: { odr: 0x40020014, bit: 5, name: 'PA5 (LD2)' } },
};
const BLINK_MS = 3000;   // Blinky toggles the LED every 3 s
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

// Checks the running Blinky over SWD without halting it: no fault, the clock
// tree Blinky asks for (and on the F4 the flash wait states, voltage scale,
// SysTick and UART divider that go with it), the core clock measured against
// this computer's clock with the cycle counter, the LED period, and that the
// rest of the first flash sector is erased.
async function boardHealth(board, image) {
  const report = [];
  const near = (got, want, tolerance, what) => {
    const error = Math.abs(got - want) / want;
    report.push(`${what} ${got.toPrecision(6)} (want ${want.toPrecision(6)}, ${(error * 100).toFixed(3)}% off)`);
    assert.ok(error <= tolerance, `${what}: ${got} vs ${want} is ${(error * 100).toFixed(2)}% off (allowed ${(tolerance * 100).toFixed(1)}%)`);
  };
  await withProbe(async (st, info) => {
    const dhcsr = await st.read32(0xe000edf0);
    assert.equal(dhcsr & (1 << 19), 0, 'core is not locked up');
    assert.equal(dhcsr & (1 << 17), 0, 'core is running, not halted');
    assert.equal(await st.read32(0xe000ed2c), 0, 'HFSR: no HardFault');
    assert.equal(await st.read32(0xe000ed28), 0, 'CFSR: no MemManage, BusFault or UsageFault');

    // image: the bytes flashed, or null for a browser build the IDE verified itself.
    const sector0 = await st.readMem(0x08000000, 16 * 1024);
    if (image) assert.deepEqual(sector0.subarray(0, image.length), image, 'the image reads back byte for byte');
    const used = image ? image.length : sector0.findLastIndex((b) => b !== 0xff) + 1;
    assert.ok(used > 0 && sector0.subarray((used + 31) & ~31).every((b) => b === 0xff), 'the rest of the first sector is erased');

    let hseHz = 0, sysHz = board.hz;
    if (board.f4) {
      const [cr, pllcfgr, cfgr, acr, pwr] = await Promise.all([0x40023800, 0x40023804, 0x40023808, 0x40023c00, 0x40007000].map((a) => st.read32(a)));
      assert.equal((cfgr >> 2) & 3, 2, 'SYSCLK runs from the PLL');
      const hse = (pllcfgr >> 22) & 1;
      hseHz = hse ? 8e6 : 0;
      const fin = hse ? 8e6 : 16e6, m = pllcfgr & 0x3f, n = (pllcfgr >> 6) & 0x1ff, p = 2 * (((pllcfgr >> 16) & 3) + 1);
      sysHz = fin / m * n / p;
      report.push(`PLL from ${hse ? 'HSE 8 MHz (ST-Link MCO)' : 'HSI 16 MHz'}: /${m} x${n} /${p}`);
      if (hse) assert.ok(cr & (1 << 17), 'HSE ready');
      near(sysHz, board.hz, 0, 'SYSCLK from RCC, Hz');
      const vco = fin / m * n;
      assert.ok(fin / m >= 1e6 && fin / m <= 2e6 && vco >= 192e6 && vco <= 432e6, `PLL input ${fin / m} Hz and VCO ${vco} Hz within the datasheet`);
      const vos = (pwr >> 14) & 3;
      assert.ok(vos >= 2, `voltage scale ${vos} allows ${sysHz / 1e6} MHz (scale 2 or higher up to 84 MHz)`);
      const latency = acr & 0xf;
      const needed = Math.ceil(sysHz / (info.volts !== null && info.volts < 2.7 ? 24e6 : 30e6)) - 1;
      report.push(`flash latency ${latency} WS (needs ${needed} at ${info.volts?.toFixed(2)} V), ART ${acr & (1 << 9) ? 'I+' : ''}${acr & (1 << 10) ? 'D+' : ''}${acr & (1 << 8) ? 'prefetch' : ''}`);
      assert.ok(latency >= needed, `flash latency ${latency} WS is enough for ${sysHz / 1e6} MHz`);
      const ppre1 = (cfgr >> 10) & 7, pclk1 = sysHz / (ppre1 < 4 ? 1 : 2 ** (ppre1 - 3));
      assert.ok(pclk1 <= 42e6, `APB1 ${pclk1 / 1e6} MHz is at most 42 MHz`);
      const [brr, ucr1] = [await st.read32(0x40004408), await st.read32(0x4000440c)];
      assert.ok((ucr1 & 0x200c) === 0x200c, 'USART2 enabled with TX and RX');
      const baud = pclk1 / ((ucr1 & (1 << 15)) ? ((brr & ~0xf) | ((brr & 7) << 1)) / 2 : brr) ;
      near(baud, 115200, 0.015, 'USART2 baud');
    }
    const [load, ctrl] = [await st.read32(0xe000e014), await st.read32(0xe000e010)];
    assert.equal(ctrl & 7, 7, 'SysTick runs from the core clock with its interrupt on');
    near(load + 1, sysHz / 1000, 0, 'SysTick reload, cycles per ms');

    // Cycle counter against this computer's clock, both sampled mid-transfer.
    await st.write32(0xe000edfc, (await st.read32(0xe000edfc)) | (1 << 24));   // DEMCR.TRCENA
    await st.write32(0xe0001000, (await st.read32(0xe0001000)) | 1);           // DWT_CTRL.CYCCNTENA
    const sample = async () => { const a = performance.now(); const c = await st.read32(0xe0001004); return [c, (a + performance.now()) / 2]; };
    const [c0, t0] = await sample();
    await new Promise((resolve) => setTimeout(resolve, 2500));
    const [c1, t1] = await sample();
    near(((c1 - c0) >>> 0) / ((t1 - t0) / 1000), sysHz, hseHz ? 0.003 : 0.02, 'core clock measured, Hz');

    // LED period: time two toggles of the output bit.
    const edges = [];
    let last = ((await st.read32(board.led.odr)) >>> board.led.bit) & 1;
    for (const end = performance.now() + 3 * BLINK_MS; performance.now() < end && edges.length < 2;) {
      const now = performance.now(), bit = ((await st.read32(board.led.odr)) >>> board.led.bit) & 1;
      if (bit !== last) { edges.push(now); last = bit; }
    }
    assert.equal(edges.length, 2, `${board.led.name} toggled twice`);
    near(edges[1] - edges[0], BLINK_MS, 0.02, `${board.led.name} period, ms`);
  });
  for (const r of report) console.log(`# ${r}`);
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
  await boardHealth(board, image);
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

test('real ST-Link: an edit in the IDE is built and is what lands on the board, edit after edit', { skip: !probe ? why : !chrome ? 'no Chrome' : false, timeout: 600000 }, async () => {
  const info = await withProbe(async (st, i) => i);
  const board = BOARDS[info.chipId];
  assert.ok(board, `no target for chip 0x${info.chipId.toString(16)} (${info.chip})`);
  const dev = await probe.find();
  const onBoard = async (text) => Buffer.from(await readBack(64 * 1024)).includes(text, 0, 'latin1');
  await withStaticIde(async ({ evaluate, waitFor, errors }) => {
    await evaluate(`(() => { const p = document.querySelector('#project'); p.value = 'blinky'; p.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await waitFor(`document.querySelector('.editor-tab.active')?.title === 'firmware/projects/blinky/main.c'`);
    let previous = 'blink %lu';
    for (const marker of [`hw-edit-${Date.now() % 100000} %lu`, `hw-again-${Date.now() % 100000} %lu`]) {
      await evaluate(`(() => { const cm = document.querySelector('.CodeMirror').CodeMirror;
        cm.setValue(cm.getValue().replaceAll(${JSON.stringify(previous)}, ${JSON.stringify(marker)})); return true; })()`);
      await waitFor(`!document.querySelector('#btn-flash').disabled`);
      const start = (await evaluate(`document.querySelector('#term-flash').textContent`)).length;
      await evaluate(`document.querySelector('#btn-flash').click()`);
      await waitFor(`/Flashed, verified|Flash failed|nothing to flash|No firmware image/.test(document.querySelector('#term-flash').textContent.slice(${start}))`, 400000);
      const log = (await evaluate(`document.querySelector('#term-flash').textContent`)).slice(start);
      assert.match(log, /Building first: firmware\/projects\/blinky\/main\.c changed/, log);
      assert.match(log, /from your build of the current sources/, log);
      assert.match(log, /Flashed, verified and started/, log);
      await waitFor(`!document.querySelector('#btn-flash').disabled`);
      assert.equal(await evaluate(`realProbe.opened`), false, 'the IDE released the probe');
      assert.ok(await onBoard(marker), `"${marker}" read back from the board`);
      assert.ok(!await onBoard(previous), `"${previous}" is gone from the board`);
      console.log(`# ${board.target}: "${marker}" built in the browser and flashed`);
      previous = marker;
    }
    assert.deepEqual(errors, []);
  }, { site: 'docs', before: bridgeScript(dev, board.target), bindings: { usbCall: usbHandler(dev) } });
  assert.ok(await ledToggles(board.led), `${board.led.name} toggles running the edited Blinky`);
  await boardHealth(board, null);   // the browser-built (Clang) firmware
});

// Repeated flashing with random images of random sizes: across the 16, 64 and
// 128 KB sector boundaries, odd lengths that need padding, every one read back
// in full along with the bytes just past it. FORGE_HW_REPEAT sets the count.
test('real ST-Link: repeated flashes of random images all read back exactly', { skip: probe ? false : why, timeout: 900000 }, async () => {
  const info = await withProbe(async (st, i) => i);
  const board = BOARDS[info.chipId];
  assert.ok(board, `no target for chip 0x${info.chipId.toString(16)} (${info.chip})`);
  const rounds = Number(process.env.FORGE_HW_REPEAT || 12);
  let seed = 0x2545f491;
  const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
  const sizes = [1, 31, 16 * 1024, 16 * 1024 + 1, 64 * 1024 - 3, 64 * 1024 + 5, 192 * 1024 + 7];
  let bytes = 0;
  const t0 = Date.now();
  for (let round = 0; round < rounds; round++) {
    const size = round < sizes.length ? sizes[round] : 1 + random() % (200 * 1024);
    const image = new Uint8Array(size).map(() => random() & 0xff);
    // The flasher erases only the sectors the image covers; check up to the end of the last one.
    const sectorEnd = await withProbe(async (st) => {
      await st.flash(image, { start: false });
      const last = st.sectors.find((x) => x.start <= 0x08000000 + size - 1 && 0x08000000 + size - 1 < x.start + x.size);
      return last.start + last.size - 0x08000000;
    });
    const back = await readBack(Math.min(sectorEnd, size + 4096));
    assert.deepEqual(back.subarray(0, size), image, `round ${round}: ${size} bytes read back`);
    assert.ok(back.subarray(size).every((b) => b === 0xff), `round ${round}: the rest of its last sector is erased`);
    bytes += size;
  }
  console.log(`# ${rounds} flashes, ${(bytes / 1024).toFixed(0)} KB, all exact, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  const blinky = prebuilt(board.target, 'blinky');
  await withProbe((st) => st.flash(blinky));
  assert.ok(await ledToggles(board.led), `${board.led.name} toggles: Blinky is back`);
});
