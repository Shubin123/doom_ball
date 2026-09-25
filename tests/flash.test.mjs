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

// ---------------------------------------------------------------- AN3155 --
class UartBootloader {
  constructor({ pid, extendedErase, flashSize, eraseUnit }) {
    this.pid = pid;
    this.cmds = [0x00, 0x01, 0x02, 0x11, 0x21, 0x31, extendedErase ? 0x44 : 0x43];
    this.flash = new Uint8Array(flashSize).fill(0);   // not erased at start
    this.eraseUnit = eraseUnit;
    this.rx = [];
    this.inbox = [];
    this.synced = false;
    this.started = null;
    this.proc = this.run();
  }
  // transport interface used by An3155
  async write(bytes) {
    this.inbox.push(...bytes);
    await this.proc.next();
  }
  async read(n, timeoutMs) {
    if (this.rx.length < n) throw new Error(`timeout waiting for ${n} byte(s)`);
    return Uint8Array.from(this.rx.splice(0, n));
  }
  reply(...b) { this.rx.push(...b); }

  // generator-based byte parser: yields when it needs more input
  *take(n) {
    while (this.inbox.length < n) yield;
    return this.inbox.splice(0, n);
  }
  *run() {
    for (;;) {
      const [first] = yield* this.take(1);
      if (!this.synced) {
        if (first === 0x7f) { this.synced = true; this.reply(0x79); }
        continue;
      }
      const [comp] = yield* this.take(1);
      if ((first ^ comp) !== 0xff || !this.cmds.includes(first)) { this.reply(0x1f); continue; }
      this.reply(0x79);
      if (first === 0x00) this.reply(this.cmds.length, 0x31, ...this.cmds, 0x79);
      else if (first === 0x02) this.reply(1, this.pid >> 8, this.pid & 0xff, 0x79);
      else if (first === 0x11 || first === 0x31 || first === 0x21) {
        const a = yield* this.take(5);
        if ((a[0] ^ a[1] ^ a[2] ^ a[3]) !== a[4]) { this.reply(0x1f); continue; }
        const addr = ((a[0] << 24) | (a[1] << 16) | (a[2] << 8) | a[3]) >>> 0;
        const off = addr - 0x08000000;
        this.reply(0x79);
        if (first === 0x21) { this.started = addr; continue; }
        if (first === 0x11) {
          const [n, nc] = yield* this.take(2);
          if ((n ^ nc) !== 0xff) { this.reply(0x1f); continue; }
          this.reply(0x79, ...this.flash.subarray(off, off + n + 1));
        } else {
          const [n] = yield* this.take(1);
          const data = yield* this.take(n + 1);
          const [sum] = yield* this.take(1);
          let x = n;
          for (const b of data) x ^= b;
          if (x !== sum || (n + 1) % 4) { this.reply(0x1f); continue; }
          for (let i = 0; i < data.length; i++) {
            if (this.flash[off + i] !== 0xff) throw new Error(`write to unerased flash at 0x${(addr + i).toString(16)}`);
            this.flash[off + i] = data[i];
          }
          this.reply(0x79);
        }
      } else if (first === 0x43) {
        const [n] = yield* this.take(1);
        const pages = yield* this.take(n + 1);
        yield* this.take(1);
        for (const p of pages) this.flash.fill(0xff, p * this.eraseUnit, (p + 1) * this.eraseUnit);
        this.reply(0x79);
      } else if (first === 0x44) {
        const [hi, lo] = yield* this.take(2);
        const n = ((hi << 8) | lo) + 1;
        const raw = yield* this.take(n * 2 + 1);
        for (let i = 0; i < n; i++) {
          const p = (raw[2 * i] << 8) | raw[2 * i + 1];
          this.flash.fill(0xff, p * this.eraseUnit, (p + 1) * this.eraseUnit);
        }
        this.reply(0x79);
      }
    }
  }
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

// ----------------------------------------------------------------- DfuSe --
class DfuDevice {
  constructor() {
    this.flash = new Uint8Array(2048 * 1024).fill(0);
    this.state = 2;
    this.addr = 0x08000000;
    this.configuration = null;
    this.left = false;
    this.pendingPoll = 0;
  }
  async open() {}
  async selectConfiguration() {
    this.configuration = { interfaces: [{ interfaceNumber: 0, alternates: [
      { alternateSetting: 0, interfaceClass: 0xfe, interfaceSubclass: 1, interfaceName: '@Internal Flash   /0x08000000/16*128Kg' },
      { alternateSetting: 1, interfaceClass: 0xfe, interfaceSubclass: 1, interfaceName: '@Option Bytes   /0x5200201C/01*128 e' },
    ] }] };
  }
  async claimInterface() {}
  async selectAlternateInterface() {}
  async controlTransferIn(setup, length) {
    if (setup.requestType === 'standard') {
      // config descriptor with a DFU functional descriptor, wTransferSize 1024
      const d = Uint8Array.of(9, 2, 27, 0, 1, 1, 0, 0x80, 50, 9, 4, 0, 0, 0, 0xfe, 1, 2, 0, 9, 0x21, 0x0b, 0xff, 0, 0x00, 0x04, 0x1a, 0x01);
      return { status: 'ok', data: new DataView(d.buffer) };
    }
    if (setup.request === 3) {
      if (this.state === 4) this.state = 5;                  // busy -> idle after poll
      else if (this.state === 6) this.state = 8, this.left = true;
      const d = Uint8Array.of(0, 5, 0, 0, this.state === 8 ? 7 : this.state, 0);
      return { status: 'ok', data: new DataView(d.buffer) };
    }
    throw new Error('unexpected IN');
  }
  async controlTransferOut(setup, data) {
    if (setup.request === 6 || setup.request === 4) { this.state = 2; return { status: 'ok' }; }
    if (setup.request !== 1) throw new Error('unexpected OUT');
    const d = data || new Uint8Array(0);
    if (setup.value === 0 && d.length === 0) { this.state = 6; return { status: 'ok' }; }   // leave
    if (setup.value === 0) {
      const a = d[1] | (d[2] << 8) | (d[3] << 16) | (d[4] << 24);
      if (d[0] === 0x21) this.addr = a >>> 0;
      else if (d[0] === 0x41) {
        const s = Math.floor(((a >>> 0) - 0x08000000) / (128 * 1024)) * 128 * 1024;
        this.flash.fill(0xff, s, s + 128 * 1024);
      }
    } else {
      const off = this.addr - 0x08000000 + (setup.value - 2) * 1024;
      if (d.length % 32) throw new Error('H7 needs 32-byte flash words');
      for (let i = 0; i < d.length; i++) {
        if (this.flash[off + i] !== 0xff) throw new Error('write to unerased flash');
        this.flash[off + i] = d[i];
      }
    }
    this.state = 4;
    return { status: 'ok' };
  }
}

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
