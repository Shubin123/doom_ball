// Flashes real firmware images through the AN3155 and DfuSe
// implementations into simulated STM32 ROM bootloaders and checks that
// flash ends up holding exactly the image.
// Run: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { An3155 } from '../ide/flash/an3155.js';
import { DfuSe, parseDfuseLayout } from '../ide/flash/dfuse.js';
import { UartBootloader, DfuDevice } from './sim_bootloaders.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function firmware(name, fallbackSize) {
  for (const p of [`firmware/build/${name}/firmware.bin`, `firmware/prebuilt/${name}.bin`]) {
    const f = path.join(root, p);
    if (existsSync(f)) return new Uint8Array(readFileSync(f));
  }
  const img = new Uint8Array(fallbackSize);
  for (let i = 0; i < img.length; i++) img[i] = (i * 7 + 3) & 0xff;
  return img;
}

for (const c of [
  { name: 'Blue Pill blinky (STM32F103, Erase 0x43)', fw: 'bluepill-blinky', size: 5000,
    dev: { pid: 0x410, extendedErase: false, flashSize: 64 * 1024, eraseUnit: 1024 } },
  { name: 'H743 DOOM (STM32H743, Extended Erase 0x44)', fw: 'h743-doom', size: 300000,
    dev: { pid: 0x450, extendedErase: true, flashSize: 2048 * 1024, eraseUnit: 128 * 1024 } },
]) {
  test(`AN3155 flashes ${c.name}`, async () => {
    const image = firmware(c.fw, c.size);
    const dev = new UartBootloader(c.dev);
    const bl = new An3155(dev);
    await bl.connect();
    assert.equal(bl.pid, c.dev.pid);
    await bl.flash(image);
    assert.deepEqual(dev.flash.subarray(0, image.length), image);
    assert.equal(dev.started, 0x08000000);
  });
}

test('AN3155 rejects an unknown chip', async () => {
  const dev = new UartBootloader({ pid: 0x999, extendedErase: false, flashSize: 1024, eraseUnit: 1024 });
  await assert.rejects(new An3155(dev).connect(), /unsupported chip/);
});

test('DfuSe layout string parsing', () => {
  assert.deepEqual(parseDfuseLayout('@Internal Flash   /0x08000000/16*128Kg'),
    [{ start: 0x08000000, sectorSize: 131072, count: 16, attrs: 'g' }]);
  assert.deepEqual(parseDfuseLayout('@Internal Flash /0x08000000/8*128Kg/0x08100000/8*128Kg').map((s) => s.start),
    [0x08000000, 0x08100000]);
});

test('DfuSe flashes H743 DOOM over USB DFU', async () => {
  const image = firmware('h743-doom', 300001);
  const dev = new DfuDevice();
  const dfu = new DfuSe(dev);
  await dfu.open();
  assert.equal(dfu.transferSize, 1024);
  await dfu.flash(image);
  assert.deepEqual(dev.flash.subarray(0, image.length), image);
  assert.ok(dev.left, 'device left DFU mode');
});
