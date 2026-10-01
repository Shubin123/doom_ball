// End-to-end flashing tests: the static IDE in headless Chrome, driven through
// its buttons and dialog, flashing simulated hardware behind fake WebUSB and
// Web Serial (tests/browser_fakes.mjs): an ST-Link/V2-1 + STM32F401RE
// (Nucleo-F401RE), an STLINK-V3 + STM32H743, the H743 DfuSe ROM bootloader
// and AN3155 UART bootloaders. Each test checks what the user sees in the
// Flash terminal and what ends up in the simulated chip's flash.
// Run: node --test tests/e2e_flash.test.mjs   (needs Chrome; set CHROME)
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chrome, withStaticIde } from './chrome_ide.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fakesSource = readFileSync(path.join(root, 'tests/browser_fakes.mjs'), 'utf8').replace(/^export /gm, '');
const skip = !chrome;

// Page script that runs before the IDE: installs the fake navigator.usb /
// navigator.serial, then (`setup`, with the simulators and `fakes` in scope)
// grants or offers simulated devices before the IDE first lists them.
function page(setup = '', { sync = '', usb = true, serial = true } = {}) {
  return `(() => {
    ${fakesSource}
    const fakes = installFakes(${JSON.stringify({ usb, serial })});
    ${sync}
    fakes.ready = (async () => {
      const { SimStLink, pattern } = await import('/tests/sim_stlink.mjs');
      const { UartBootloader, DfuDevice, BootloaderSerialPort, ConsoleSerialPort } = await import('/tests/sim_bootloaders.mjs');
      Object.assign(window, { SimStLink, pattern, UartBootloader, DfuDevice, BootloaderSerialPort, ConsoleSerialPort });
      ${setup}
    })();
  })();`;
}

const DONE = String.raw`/Flashed|Flash failed|nothing to flash|No firmware image|Firmware image is|Instant flash (needs|uses)|Could not read/`;

// Helpers bound to one page.
function ui({ evaluate, waitFor }) {
  const flashLog = () => evaluate(`document.querySelector('#term-flash').textContent`);
  return {
    flashLog,
    select: (id, value) => evaluate(`(() => { const s = document.querySelector('#${id}'); s.value = '${value}'; s.dispatchEvent(new Event('change', { bubbles: true })); return s.value; })()`),
    // Clicks and returns the Flash terminal text the action added.
    async run(clickExpression, timeout = 30000) {
      const start = (await flashLog()).length;
      await evaluate(clickExpression);
      await waitFor(`${DONE}.test(document.querySelector('#term-flash').textContent.slice(${start}))`, timeout);
      return (await flashLog()).slice(start);
    },
    flash(timeout) { return this.run(`document.querySelector('#btn-flash').click()`, timeout); },
    // Opens the ▾ dialog, picks a method and presses Connect & flash.
    async dialog(method, timeout) {
      await evaluate(`document.querySelector('#btn-flash-more').click()`);
      await waitFor(`document.querySelector('#flash-dialog').open`);
      await evaluate(`document.querySelector('#m-${method} input').checked = true`);
      return this.run(`document.querySelector('#fd-go').click()`, timeout);
    },
    // True when the simulated flash starts with the prebuilt image.
    holds: (simulated, name) => evaluate(`fetch('firmware/prebuilt/${name}.bin').then((r) => r.arrayBuffer()).then((b) => {
      const want = new Uint8Array(b), got = ${simulated};
      return want.length > 0 && want.every((x, i) => got[i] === x);
    })`),
    idle: () => waitFor(`!document.querySelector('#btn-flash').disabled && document.querySelector('#flash-progress').hidden`, 5000),
  };
}

// ----------------------------------------------------------- the bundle --
test('ide/forge.js, the script the page runs, is built from the current ide/ modules', () => {
  const bundle = path.join(root, 'ide/forge.js');
  const before = readFileSync(bundle, 'utf8');
  execFileSync(process.execPath, [path.join(root, 'tools/bundle_ide.mjs')]);
  const after = readFileSync(bundle, 'utf8');
  if (after !== before) writeFileSync(bundle, before);
  assert.ok(after === before, 'ide/forge.js is stale: run node tools/bundle_ide.mjs');
  for (const name of ['H7_LOADER', 'h7Sectors', 'class StLink']) assert.ok(before.includes(name), `bundle has ${name}`);
});

// ------------------------------------------------------ instant flash --
test('STM32H743 + STLINK-V3: Flash programs blinky then DOOM with one click each', { skip }, async () => {
  await withStaticIde(async (page) => {
    const { evaluate, errors } = page, u = ui(page);
    assert.equal(await evaluate(`document.querySelector('#target').value`), 'h743', 'a standalone STLINK-V3 does not pick the Nucleo target');
    assert.doesNotMatch(await u.flashLog(), /ST-Link found/);
    assert.equal(await evaluate(`document.querySelector('#btn-flash').textContent`), 'Flash');
    assert.match(await evaluate(`document.querySelector('#btn-flash').title`), /ST-Link/);

    await u.select('project', 'blinky');
    let log = await u.flash();
    assert.match(log, /Instant flash: Blinky → STM32H743IITx, 13 KB from prebuilt firmware\/prebuilt\/h743-blinky\.bin/);
    assert.match(log, /STLINK-V3 J17: STM32H74x\/75x \(id 0x450\), 2048 KB flash, SWD 0x2ba01477, target 3\.30 V/);
    assert.match(log, /erasing 1 sector \(128 KB\)/);
    assert.match(log, /Flashed, verified and started 13 KB in [\d.]+s\./, log);
    assert.equal(await evaluate(`document.querySelector('#flash-dialog').open`), false, 'no dialog');
    assert.deepEqual(await evaluate(`fakes.usb.requests`), [], 'no device picker');
    assert.equal(await u.holds('dev.flash', 'h743-blinky'), true);
    assert.equal(await evaluate(`dev.running && !dev.halted && dev.mode === 1 && !dev.claimed && !dev.opened`), true, 'runs, probe released');
    await u.idle();

    await u.select('project', 'doom');
    log = await u.flash();
    assert.match(log, /DOOM → STM32H743IITx, 326 KB/);
    assert.match(log, /erasing 3 sectors \(384 KB\)/);
    assert.match(log, /Flashed, verified and started 326 KB/, log);
    assert.equal(await u.holds('dev.flash', 'h743-doom'), true);
    assert.deepEqual(errors, []);
  }, { before: page(`window.dev = new SimStLink({ family: 'h7' }); fakes.usb.granted.push(dev);`) });
});

test('Nucleo-F401RE: an allowed ST-Link/V2-1 selects the board, Flash programs it with no dialog', { skip }, async () => {
  await withStaticIde(async (page) => {
    const { evaluate, errors } = page, u = ui(page);
    assert.equal(await evaluate(`document.querySelector('#target').value`), 'f401');
    assert.match(await u.flashLog(), /ST-Link found: selected the Nucleo-F401RE/);
    assert.equal(await evaluate(`document.querySelector('#project').value`), 'blinky');
    const log = await u.flash();
    assert.match(log, /ST-Link\/V2 J48: STM32F401xD\/E \(id 0x433\), 512 KB flash/);
    assert.match(log, /Flashed, verified and started 5\.4 KB/, log);
    assert.equal(await evaluate(`document.querySelector('#flash-dialog').open`), false);
    assert.equal(await u.holds('dev.flash', 'f401-blinky'), true);
    assert.deepEqual(await evaluate(`dev.erased`), [0]);
    assert.deepEqual(errors, []);
  }, { before: page(`window.dev = new SimStLink(); fakes.usb.granted.push(dev);`) });
});

test('the board chosen last wins over a detected ST-Link', { skip }, async () => {
  await withStaticIde(async ({ evaluate }) => {
    assert.equal(await evaluate(`document.querySelector('#target').value`), 'bluepill');
    assert.equal(await evaluate(`document.querySelector('#btn-flash').textContent`), 'Flash…', 'ROM bootloader board: Flash opens the dialog');
  }, { before: page(`fakes.usb.granted.push(new SimStLink());`, { sync: `localStorage.setItem('stm32-forge-target', 'bluepill');` }) });
});

test('first flash asks for the ST-Link once; later flashes need no picker', { skip }, async () => {
  await withStaticIde(async (page) => {
    const { evaluate, errors } = page, u = ui(page);
    await u.select('project', 'blinky');
    let log = await u.flash();
    assert.match(log, /Select the ST-Link \("STM32 STLink" or "STLINK-V3"\) once/);
    assert.match(log, /Flashed, verified and started 13 KB/, log);
    const filters = await evaluate(`fakes.usb.requests[0]`);
    assert.equal(await evaluate(`fakes.usb.requests.length`), 1);
    for (const pid of [0x3748, 0x374b, 0x374e, 0x374f, 0x3752, 0x3753, 0x3754]) {
      assert.ok(filters.some((f) => f.vendorId === 0x0483 && f.productId === pid), `picker offers 0483:${pid.toString(16)}`);
    }
    await u.idle();
    log = await u.flash();
    assert.match(log, /Flashed, verified/);
    assert.doesNotMatch(log, /Select the ST-Link/);
    assert.equal(await evaluate(`fakes.usb.requests.length`), 1, 'no second picker');
    assert.deepEqual(errors, []);
  }, { before: page(`window.dev = new SimStLink({ family: 'h7' }); fakes.usb.picker = dev;`) });
});

test('cancelling the ST-Link picker explains what to do and Flash works again', { skip }, async () => {
  await withStaticIde(async (page) => {
    const { evaluate, errors } = page, u = ui(page);
    let log = await u.flash();
    assert.match(log, /Flash failed: No device selected\./);
    assert.match(log, /No ST-Link was chosen\. Plug the ST-Link in with a data USB cable/);
    await u.idle();
    await evaluate(`fakes.usb.picker = new SimStLink({ family: 'h7' })`);
    log = await u.flash();
    assert.match(log, /Flashed, verified and started/, log);
    assert.deepEqual(errors, []);
  }, { before: page() });
});

test('an ST-Link held by another program is reported as busy', { skip }, async () => {
  await withStaticIde(async (page) => {
    const { errors } = page, u = ui(page);
    const log = await u.flash();
    assert.match(log, /Flash failed: Access denied\./);
    assert.match(log, /Another program is using the ST-Link: STM32CubeProgrammer\/CubeIDE, st-flash\/st-util, OpenOCD/);
    await u.idle();
    assert.deepEqual(errors, []);
  }, { before: page(`fakes.usb.granted.push(new SimStLink({ family: 'h7', busy: true }));`) });
});

test('flashing the wrong board is refused before erasing, naming the right target', { skip }, async () => {
  await withStaticIde(async (page) => {
    const { evaluate, errors } = page, u = ui(page);
    await u.select('target', 'f401');
    const log = await u.flash();
    assert.match(log, /Flash failed: this board is an STM32H74x\/75x, not the STM32F401RE Nucleo-F401RE; select the STM32H743IITx target/);
    assert.equal(await evaluate(`dev.erased.length === 0 && dev.flash.every((x, i) => x === pattern(dev.flash.length, 99)[i])`), true, 'flash untouched');
    assert.equal(await evaluate(`dev.running && !dev.claimed`), true);
    assert.deepEqual(errors, []);
  }, { before: page(`window.dev = new SimStLink({ family: 'h7', flashKb: 64 }); fakes.usb.granted.push(dev);`) });
});

test('an unsupported chip behind the ST-Link is refused', { skip }, async () => {
  await withStaticIde(async (page) => {
    const u = ui(page);
    await u.select('target', 'f401');
    assert.match(await u.flash(), /Flash failed: target 0x410 is not a supported STM32F4/);
  }, { before: page(`fakes.usb.granted.push(new SimStLink({ chipId: 0x410 }));`) });
});

test('unplugging mid-flash fails cleanly; replugging announces the probe and Flash recovers', { skip }, async () => {
  await withStaticIde(async (page) => {
    const { evaluate, waitFor, errors } = page, u = ui(page);
    await u.select('project', 'blinky');
    let log = await u.flash();
    assert.match(log, /Flash failed: A transfer error has occurred\./, log);
    await u.idle();
    await evaluate(`fakes.usb.unplug(dev)`);
    await waitFor(`document.querySelector('#term-flash').textContent.includes('ST-Link disconnected.')`);
    await evaluate(`window.dev = new SimStLink({ family: 'h7' }); fakes.usb.plug(dev)`);
    await waitFor(`document.querySelector('#term-flash').textContent.includes('ST-Link connected: instant flash ready.')`);
    log = await u.flash();
    assert.match(log, /Flashed, verified and started 13 KB/, log);
    assert.equal(await u.holds('dev.flash', 'h743-blinky'), true);
    assert.deepEqual(errors, []);
  }, { before: page(`window.dev = new SimStLink({ family: 'h7', unplugAfter: 150 }); fakes.usb.granted.push(dev);`) });
});

test('a verify mismatch is reported with its address', { skip }, async () => {
  await withStaticIde(async (page) => {
    const u = ui(page);
    assert.match(await u.flash(), /Flash failed: verify failed at 0x08000400: wrote 0x[0-9a-f]+, read 0x[0-9a-f]+/);
  }, { before: page(`fakes.usb.granted.push(new SimStLink({ family: 'h7', flakyAt: 0x400 }));`) });
});

test('a second click while flashing does not start a second flash', { skip }, async () => {
  await withStaticIde(async (page) => {
    const { evaluate, errors } = page, u = ui(page);
    await u.select('project', 'blinky');
    const log = await u.run(`(() => { const b = document.querySelector('#btn-flash'); b.click(); b.disabled = false; b.click(); return true; })()`);
    await u.idle();
    const full = await u.flashLog();
    assert.equal(full.match(/Instant flash:/g).length, 1, full);
    assert.equal(full.match(/Flashed, verified/g).length, 1, log);
    assert.deepEqual(await evaluate(`dev.erased`), [0]);
    assert.deepEqual(errors, []);
  }, { before: page(`window.dev = new SimStLink({ family: 'h7' }); fakes.usb.granted.push(dev);`) });
});

test('browsers without WebUSB are told to use Chrome or Edge', { skip }, async () => {
  await withStaticIde(async (page) => {
    const { evaluate, errors } = page, u = ui(page);
    assert.match(await u.flash(), /Instant flash uses WebUSB, which this browser does not have\. Use Chrome or Edge\./);
    await evaluate(`document.querySelector('#btn-flash-more').click()`);
    await page.waitFor(`document.querySelector('#flash-dialog').open`);
    assert.match(await evaluate(`document.querySelector('#fd-support').textContent`), /WebUSB is not available in this browser.*Use Chrome or Edge/);
    assert.deepEqual(errors, []);
  }, { before: page('', { usb: false }) });
});

test('a project with no prebuilt image asks for a build instead of flashing', { skip }, async () => {
  await withStaticIde(async (page) => {
    const { evaluate } = page, u = ui(page);
    await u.select('project', 'button-led');
    assert.match(await u.flash(), /No firmware image: build first\./);
    assert.equal(await evaluate(`dev.mode === 1 && !dev.opened`), true, 'the probe was not touched');
  }, { before: page(`window.dev = new SimStLink({ family: 'h7' }); fakes.usb.granted.push(dev);`) });
});

// ------------------------------------------------------ serial console --
test('after instant flash the ST-Link serial port is connected and shows the board output', { skip }, async () => {
  await withStaticIde(async (page) => {
    const { evaluate, waitFor, errors } = page, u = ui(page);
    await u.flash();
    await waitFor(`document.querySelector('#term-flash').textContent.includes('Serial console connected to the ST-Link USB serial port.')`);
    await waitFor(`document.querySelector('#term-serial').textContent.includes('blink 0')`);
    assert.equal(await evaluate(`document.querySelector('#term-serial').classList.contains('active')`), true);
    assert.deepEqual(await evaluate(`vcp.opens`), [{ baudRate: 115200 }]);
    assert.equal(await evaluate(`fakes.serial.requests`), 0, 'no port picker');
    assert.deepEqual(errors, []);
  }, { before: page(`window.dev = new SimStLink({ family: 'h7' }); fakes.usb.granted.push(dev);
    window.vcp = new ConsoleSerialPort({ usbProductId: 0x3754, text: 'STM32 Forge blinky @ 400 MHz\\nblink 0\\n' }); fakes.serial.granted.push(vcp);`) });
});

test('a busy serial port after flashing is explained; the flash itself still succeeded', { skip }, async () => {
  await withStaticIde(async (page) => {
    const { waitFor } = page, u = ui(page);
    assert.match(await u.flash(), /Flashed, verified and started/);
    await waitFor(`/could not open the serial port: Failed to open serial port\\. Another tab or program/.test(document.querySelector('#term-flash').textContent)`);
  }, { before: page(`fakes.usb.granted.push(new SimStLink({ family: 'h7' }));
    fakes.serial.granted.push(new ConsoleSerialPort({ usbProductId: 0x3754, busy: true }));`) });
});

test('with no serial port allowed yet, the IDE says how to connect one', { skip }, async () => {
  await withStaticIde(async (page) => {
    const { waitFor } = page, u = ui(page);
    await u.flash();
    await waitFor(`document.querySelector('#term-flash').textContent.includes('Press Connect serial and choose the STLink port once')`);
  }, { before: page(`fakes.usb.granted.push(new SimStLink({ family: 'h7' }));`) });
});

// --------------------------------------------------- the ▾ flash dialog --
test('▾ dialog on the H743 offers all three methods and flashes over USB DFU', { skip }, async () => {
  await withStaticIde(async (page) => {
    const { evaluate, waitFor, errors } = page, u = ui(page);
    await u.select('project', 'blinky');
    await evaluate(`document.querySelector('#btn-flash-more').click()`);
    await waitFor(`document.querySelector('#flash-dialog').open`);
    assert.equal(await evaluate(`document.querySelector('#fd-what').textContent`), 'Blinky → STM32H743IITx');
    assert.match(await evaluate(`document.querySelector('#fd-image').textContent`), /13 KB from prebuilt/);
    assert.equal(await evaluate(`document.querySelector('#m-stlink input').checked`), true, 'instant flash preselected');
    assert.equal(await evaluate(`['stlink', 'uart', 'dfu'].every((m) => !document.querySelector('#m-' + m + ' input').disabled)`), true);
    await evaluate(`document.querySelector('#flash-dialog').close('cancel')`);

    const log = await u.dialog('dfu');
    assert.match(log, /Flashed and verified 13 KB/, log);
    assert.deepEqual(await evaluate(`fakes.usb.requests.at(-1)`), [{ vendorId: 0x0483, productId: 0xdf11 }]);
    assert.equal(await u.holds('dfu.flash', 'h743-blinky'), true);
    assert.equal(await evaluate(`dfu.left`), true, 'left DFU mode to start the firmware');
    assert.deepEqual(errors, []);
  }, { before: page(`window.dfu = Object.assign(new DfuDevice(), { vendorId: 0x0483, productId: 0xdf11 }); fakes.usb.picker = dfu;`) });
});

test('▾ dialog flashes the H743 over the UART bootloader (AN3155, 8E1)', { skip }, async () => {
  await withStaticIde(async (page) => {
    const { evaluate, errors } = page, u = ui(page);
    await u.select('project', 'doom');
    const log = await u.dialog('uart', 60000);
    assert.match(log, /Flashed and verified 326 KB/, log);
    assert.equal(await u.holds('bl.flash', 'h743-doom'), true);
    assert.equal(await evaluate(`bl.started`), 0x08000000, 'Go command to the image');
    assert.deepEqual(await evaluate(`port.opens`), [{ baudRate: 115200, dataBits: 8, parity: 'even', stopBits: 1 }]);
    assert.deepEqual(errors, []);
  }, { before: page(`window.bl = new UartBootloader({ pid: 0x450, extendedErase: true, flashSize: 2048 * 1024, eraseUnit: 128 * 1024 });
    window.port = new BootloaderSerialPort(bl); fakes.serial.picker = port;`) });
});

test('▾ dialog instant flash option goes through the ST-Link', { skip }, async () => {
  await withStaticIde(async (page) => {
    const u = ui(page);
    await u.select('project', 'blinky');
    assert.match(await u.dialog('stlink'), /Flashed, verified and started 13 KB/);
    assert.equal(await u.holds('dev.flash', 'h743-blinky'), true);
  }, { before: page(`window.dev = new SimStLink({ family: 'h7' }); fakes.usb.granted.push(dev);`) });
});

test('Blue Pill: Flash… opens the dialog with only the UART bootloader, which flashes it', { skip }, async () => {
  await withStaticIde(async (page) => {
    const { evaluate, waitFor, send, errors } = page, u = ui(page);
    await u.select('target', 'bluepill');
    assert.equal(await evaluate(`document.querySelector('#btn-flash').textContent`), 'Flash…');
    await evaluate(`document.querySelector('#btn-flash').click()`);
    await waitFor(`document.querySelector('#flash-dialog').open`);
    assert.equal(await evaluate(`document.querySelector('#m-uart input').checked`), true);
    assert.equal(await evaluate(`document.querySelector('#m-stlink input').disabled && document.querySelector('#m-dfu input').disabled`), true);
    // Arrow keys in the radio group must not reach the disabled methods.
    await evaluate(`document.querySelector('#m-uart input').focus()`);
    for (const key of ['ArrowDown', 'ArrowUp', 'ArrowUp']) {
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode: key === 'ArrowDown' ? 40 : 38 });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: key === 'ArrowDown' ? 40 : 38 });
    }
    assert.equal(await evaluate(`document.querySelector('#m-uart input').checked`), true);
    const log = await u.run(`document.querySelector('#fd-go').click()`);
    assert.match(log, /Flashed and verified 5\.0 KB/, log);
    assert.equal(await u.holds('bl.flash', 'bluepill-blinky'), true);
    assert.deepEqual(errors, []);
  }, { before: page(`window.bl = new UartBootloader({ pid: 0x410, extendedErase: false, flashSize: 64 * 1024, eraseUnit: 1024 });
    fakes.serial.picker = new BootloaderSerialPort(bl);`) });
});

test('▾ dialog flashes a rebuilt .bin the user picks, and rejects one that does not fit', { skip }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'forge-e2e-'));
  const custom = path.join(dir, 'custom.bin'), huge = path.join(dir, 'huge.bin');
  const bytes = Buffer.alloc(20000);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 13 + 5) & 0xff;
  writeFileSync(custom, bytes);
  writeFileSync(huge, Buffer.alloc(3 * 1024 * 1024, 0xa5));
  try {
    await withStaticIde(async (page) => {
      const { evaluate, waitFor, setFiles, errors } = page, u = ui(page);
    await u.select('project', 'blinky');
      await evaluate(`document.querySelector('#btn-flash-more').click()`);
      await waitFor(`document.querySelector('#flash-dialog').open`);
      await setFiles('#custom-firmware', [custom]);
      await waitFor(`document.querySelector('#fd-image').textContent === '20 KB from rebuilt image custom.bin'`);
      let log = await u.run(`document.querySelector('#fd-go').click()`);
      assert.match(log, /Instant flash: Blinky → STM32H743IITx, 20 KB from custom\.bin/);
      assert.match(log, /Flashed, verified and started 20 KB/, log);
      assert.equal(await evaluate(`[...dev.flash.subarray(0, 20000)].every((x, i) => x === ((i * 13 + 5) & 0xff))`), true);
      await u.idle();

      await evaluate(`document.querySelector('#btn-flash-more').click()`);
      await waitFor(`document.querySelector('#flash-dialog').open`);
      await setFiles('#custom-firmware', [huge]);
      log = await u.run(`document.querySelector('#fd-go').click()`);
      assert.match(log, /Firmware image is 3\.00 MB; STM32H743IITx has 2\.00 MB flash\./);
      assert.doesNotMatch(log, /Instant flash:/);
      assert.deepEqual(errors, []);
    }, { before: page(`window.dev = new SimStLink({ family: 'h7' }); fakes.usb.granted.push(dev);`) });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------- build in the browser, flash --
test('a firmware built in the browser is what Flash programs', { skip: skip || process.env.FORGE_TEST_WASM_BUILD !== '1', timeout: 600000 }, async () => {
  await withStaticIde(async (page) => {
    const { evaluate, waitFor, errors } = page, u = ui(page);
    await evaluate(`document.querySelector('#btn-build').click()`);
    await waitFor(`/Build succeeded|Build failed/.test(document.querySelector('#term-build').textContent)`, 400000);
    assert.match(await evaluate(`document.querySelector('#term-build').textContent`), /Build succeeded/);
    const log = await u.flash();
    assert.match(log, /Instant flash: Blinky → STM32H743IITx, [\d.]+ KB from your latest build/, log);
    assert.match(log, /Flashed, verified and started/, log);
    assert.equal(await evaluate(`(() => { const sp = new DataView(dev.flash.buffer).getUint32(0, true), pc = new DataView(dev.flash.buffer).getUint32(4, true);
      return sp >= 0x20000000 && sp <= 0x24080000 && (pc & 0xfff00001) === 0x08000001; })()`), true, 'vector table of an H743 image');
    assert.deepEqual(errors, []);
  }, { before: page(`window.dev = new SimStLink({ family: 'h7' }); fakes.usb.granted.push(dev);`) });
});
