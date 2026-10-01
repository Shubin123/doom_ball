// Flashes firmware through the ST-Link instant-flash implementation into a
// simulated ST-Link/V2-1 + STM32F401RE: the USB command protocol, SWD memory
// access, the F4 flash controller (keys, sector erase, program-only-clears-bits)
// and the SRAM loader, which the simulator executes by its documented effect.
// Run: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { StLink } from '../ide/flash/stlink.js';
import { SimStLink, pattern } from './sim_stlink.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function firmware(name, fallbackSize) {
  for (const p of [`firmware/build/${name}/firmware.bin`, `firmware/prebuilt/${name}.bin`]) {
    const f = path.join(root, p);
    if (existsSync(f)) return new Uint8Array(readFileSync(f));
  }
  return pattern(fallbackSize, 3);
}
async function flashSim(sim, image) {
  const log = [];
  const phases = new Set();
  const st = new StLink(sim, (s) => log.push(s));
  const info = await st.connect();
  await st.flash(image, { onProgress: (p) => phases.add(p) });
  await st.close();
  return { info, log, phases };
}

test('Nucleo-F401RE blinky: erase, program, verify and run', async () => {
  const sim = new SimStLink();
  const image = firmware('f401-blinky', 5508);
  const { info, phases, log } = await flashSim(sim, image);
  assert.equal(info.chip, 'STM32F401xD/E');
  assert.equal(info.flashSize, 512 * 1024);
  assert.deepEqual(sim.flash.subarray(0, image.length), image);
  assert.deepEqual(sim.erased, [0], 'only the first 16 KB sector is erased');
  assert.ok(sim.cr & 0x80000000, 'flash locked again');
  assert.ok(sim.running && !sim.halted, 'core runs the new firmware');
  assert.equal(sim.demcr & 1, 0, 'reset vector catch cleared');
  assert.equal(sim.mode, 1, 'ST-Link left debug mode');
  assert.ok(!sim.claimed && !sim.opened, 'USB interface released');
  assert.deepEqual([...phases], ['erase', 'write', 'verify']);
  assert.ok(log.some((l) => /verified/.test(l)));
});

test('image spanning 16, 64 and 128 KB sectors', async () => {
  const sim = new SimStLink();
  const image = pattern(200 * 1024 + 3, 5);          // odd length: padded to a word
  await flashSim(sim, image);
  assert.deepEqual(sim.flash.subarray(0, image.length), image);
  assert.deepEqual(sim.erased, [0, 1, 2, 3, 4, 5]);
});

test('firmware that turned SWD off is reached by connecting under reset', async () => {
  const sim = new SimStLink({ swdAsleep: true });
  const image = pattern(4096, 1);
  const { log } = await flashSim(sim, image);
  assert.ok(log.some((l) => /under reset/.test(l)));
  assert.deepEqual(sim.flash.subarray(0, image.length), image);
});

test('verify catches a bit that did not program', async () => {
  const sim = new SimStLink({ flakyAt: 3000 });
  await assert.rejects(flashSim(sim, pattern(8192, 2)), /verify failed at 0x08000bb8/);
});

test('refuses unsupported chips and oversized images', async () => {
  await assert.rejects(new StLink(new SimStLink({ chipId: 0x410 })).connect(), /not a supported STM32F4/);
  const st = new StLink(new SimStLink({ flashKb: 256, chipId: 0x423 }));
  await st.connect();
  await assert.rejects(st.flash(new Uint8Array(300 * 1024)), /does not fit in 256 KB/);
});

test('STLINK-V3 + STM32H743 blinky: H7 controller, AXI SRAM loader, verify and run', async () => {
  const sim = new SimStLink({ family: 'h7' });
  const image = firmware('h743-blinky', 13588);
  const { info, phases, log } = await flashSim(sim, image);
  assert.equal(info.chip, 'STM32H74x/75x');
  assert.equal(info.chipId, 0x450);
  assert.equal(info.flashSize, 2048 * 1024);
  assert.equal(info.probe, 'STLINK-V3 J17');
  assert.ok(Math.abs(info.volts - 3.3) < 0.01);
  assert.deepEqual(sim.flash.subarray(0, image.length), image);
  assert.ok(sim.flash.subarray(image.length, 128 * 1024).every((x) => x === 0xff), 'flash-word padding is erased flash');
  assert.deepEqual(sim.erased, [0], 'only the first 128 KB sector is erased');
  assert.ok(sim.bank[0].cr & 1, 'bank 1 locked again');
  assert.ok(sim.running && !sim.halted, 'core runs the new firmware');
  assert.equal(sim.mode, 1, 'ST-Link left debug mode');
  assert.deepEqual([...phases], ['erase', 'write', 'verify']);
  assert.ok(log.some((l) => /STLINK-V3 J17: STM32H74x\/75x .* 2048 KB flash/.test(l)), log.join('\n'));
});

test('STM32H743 DOOM image', async () => {
  const sim = new SimStLink({ family: 'h7' });
  const image = firmware('h743-doom', 334188);
  await flashSim(sim, image);
  assert.deepEqual(sim.flash.subarray(0, image.length), image);
  assert.deepEqual(sim.erased, [0, 1, 2]);
});

test('STM32H743 image across both flash banks', async () => {
  const sim = new SimStLink({ family: 'h7' });
  const image = pattern(1024 * 1024 + 200 * 1024 + 5, 7);   // 1.2 MB, odd length
  await flashSim(sim, image);
  assert.deepEqual(sim.flash.subarray(0, image.length), image);
  assert.deepEqual(sim.erased, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.ok((sim.bank[0].cr & 1) && (sim.bank[1].cr & 1), 'both banks locked again');
});

test('STM32H743 at low supply erases and programs with x32 parallelism', async () => {
  const sim = new SimStLink({ family: 'h7', volts: 2.0 });
  const image = pattern(4096, 4);
  const { info } = await flashSim(sim, image);
  assert.ok(info.volts < 2.7);
  assert.deepEqual(sim.flash.subarray(0, image.length), image);
});

test('STM32H743 verify catches a bit that did not program', async () => {
  const sim = new SimStLink({ family: 'h7', flakyAt: 70000 });
  await assert.rejects(flashSim(sim, pattern(100 * 1024, 2)), /verify failed at 0x08011170/);
});

test('1 MB STM32H743 refuses an image that runs into the bank gap', async () => {
  const st = new StLink(new SimStLink({ family: 'h7', flashKb: 1024 }));
  await st.connect();
  await assert.rejects(st.flash(new Uint8Array(600 * 1024)), /does not fit in 1024 KB/);
});

test('a probe that disappears mid-flash fails cleanly', async () => {
  const sim = new SimStLink({ family: 'h7', unplugAfter: 120 });
  await assert.rejects(flashSim(sim, pattern(64 * 1024, 1)), /transfer error/);
});
