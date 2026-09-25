// Simulated ST-Link/V2-1 wired to an STM32F401RE, with the WebUSB device
// surface the ST-Link flasher uses. Shared by tests/stlink.test.mjs and the
// headless-Chrome IDE test, so it avoids Node-only modules.
import { F4_LOADER, f4Sectors } from '../ide/flash/stlink.js';

const le32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
function check(condition, message = 'simulator: protocol violation') {
  if (!condition) throw new Error(message);
}
export function pattern(size, seed) {
  const img = new Uint8Array(size);
  for (let i = 0; i < img.length; i++) img[i] = (i * 7 + seed + (i >> 8)) & 0xff;
  return img;
}

const FLASH_BASE = 0x08000000, SRAM = 0x20000000;

export class SimStLink {
  constructor({ chipId = 0x433, flashKb = 512, swdAsleep = false, flakyAt = -1 } = {}) {
    this.vendorId = 0x0483; this.productId = 0x374b;
    this.opened = false; this.configuration = null;
    this.mode = 1;                              // mass storage, as after plug-in
    this.chipId = chipId; this.flashKb = flashKb;
    this.flash = pattern(flashKb * 1024, 99);   // old firmware, not erased
    this.sram = new Uint8Array(96 * 1024);
    this.sectors = f4Sectors(flashKb * 1024);
    this.erased = [];
    this.swdAsleep = swdAsleep; this.nrstLow = false; this.flakyAt = flakyAt;
    this.regs = new Uint32Array(20);
    this.halted = false; this.resetCount = 0; this.running = true;
    this.dhcsr = 0; this.demcr = 0;
    this.cr = 0x80000000; this.sr = 0; this.keys = [];
    this.pending = null; this.reply = null; this.rwStatus = 0x80;
  }
  // WebUSB surface
  async open() { this.opened = true; }
  async close() { this.opened = false; }
  async selectConfiguration() {
    this.configuration = { interfaces: [
      { interfaceNumber: 0, alternates: [{ interfaceClass: 0xff, endpoints: [
        { endpointNumber: 1, direction: 'in', type: 'bulk' },
        { endpointNumber: 1, direction: 'out', type: 'bulk' },
        { endpointNumber: 2, direction: 'in', type: 'bulk' }] }] },
      { interfaceNumber: 1, alternates: [{ interfaceClass: 0x08, endpoints: [] }] }] };
  }
  async claimInterface(n) { check(n === 0, 'wrong interface claimed'); this.claimed = true; }
  async releaseInterface() { this.claimed = false; }
  async transferOut(ep, data) {
    check(ep === 1, `wrong endpoint ${ep}`);
    const b = new Uint8Array(data);
    if (this.pending) { this.pending(b); this.pending = null; return { status: 'ok' }; }
    check(b.length === 16, 'ST-Link commands are 16-byte frames');
    this.command(b);
    return { status: 'ok' };
  }
  async transferIn(ep, length) {
    check(ep === 1, `wrong endpoint ${ep}`);
    check(this.reply, 'IN transfer without a pending reply');
    const r = this.reply; this.reply = null;
    check(r.length === length, `reply is ${r.length} bytes, host read ${length}`);
    return { status: 'ok', data: new DataView(r.buffer) };
  }

  status(ok) { return ok ? 0x80 : 0x81; }
  swdUp() { return this.mode === 2 && (!this.swdAsleep || this.nrstLow || this.halted); }

  command(c) {
    const out = (...bytes) => { this.reply = Uint8Array.from(bytes); };
    const val = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, v >>> 24];
    if (c[0] === 0xf1) return out(0x2c, 0x23, 0x83, 0x04, 0x4b, 0x37);
    if (c[0] === 0xf5) return out(this.mode, 0);
    if (c[0] !== 0xf2) return;
    const addr = le32(c, 2);
    switch (c[1]) {
      case 0x21: this.mode = 1; return;
      case 0x30: this.mode = 2; return out(0x80, 0);
      case 0x43: return out(0x80, 0);
      case 0x3c: this.nrstLow = c[2] === 0; if (!this.nrstLow) this.systemReset(); return out(0x80, 0);
      case 0x31: return this.swdUp() ? out(0x80, 0, 0, 0, ...val(0x2ba01477), 0, 0, 0, 0) : out(0x81, ...new Array(11).fill(0));
      case 0x36: { const ok = this.swdUp(); return out(this.status(ok), 0, 0, 0, ...val(ok ? this.read32(addr) : 0)); }
      case 0x35: { const ok = this.swdUp(); if (ok) this.write32(addr, le32(c, 6)); return out(this.status(ok), 0); }
      case 0x33: check(this.halted, 'register read while running'); return out(0x80, 0, 0, 0, ...val(this.regs[c[2]]));
      case 0x34: check(this.halted, 'register write while running'); this.regs[c[2]] = le32(c, 3); return out(0x80, 0);
      case 0x3e: return out(this.rwStatus, ...new Array(11).fill(0));
      case 0x07: {
        const n = c[6] | (c[7] << 8);
        check(n <= 1024 && Math.floor(addr / 1024) === Math.floor((addr + n - 1) / 1024), 'transfer crosses a 1 KB boundary');
        this.reply = this.readBytes(addr, n);
        return;
      }
      case 0x08: {
        const n = c[6] | (c[7] << 8);
        check(n <= 1024 && Math.floor(addr / 1024) === Math.floor((addr + n - 1) / 1024), 'transfer crosses a 1 KB boundary');
        this.pending = (data) => { check(data.length === n, 'data phase length'); this.writeBytes(addr, data); };
        return;
      }
      default: throw new Error(`simulator: unknown debug command 0x${c[1].toString(16)}`);
    }
  }

  readBytes(addr, n) {
    if (addr >= FLASH_BASE && addr + n <= FLASH_BASE + this.flash.length) return this.flash.slice(addr - FLASH_BASE, addr - FLASH_BASE + n);
    if (addr >= SRAM && addr + n <= SRAM + this.sram.length) return this.sram.slice(addr - SRAM, addr - SRAM + n);
    this.rwStatus = 0x81;
    return new Uint8Array(n);
  }
  writeBytes(addr, data) {
    check(addr >= SRAM && addr + data.length <= SRAM + this.sram.length, `debugger bulk write outside SRAM at 0x${addr.toString(16)}`);
    this.sram.set(data, addr - SRAM);
  }

  read32(addr) {
    switch (addr) {
      case 0xe0042000: return 0x10000000 | this.chipId;
      case 0x1fff7a20: return (this.flashKb << 16) >>> 0;
      case 0xe000edf0: return (this.dhcsr & 0xffff) | (this.halted ? 1 << 17 : 0);
      case 0xe000edfc: return this.demcr;
      case 0x40023c0c: return this.sr;
      case 0x40023c10: return this.cr;
      default: return le32(this.readBytes(addr, 4), 0);
    }
  }
  write32(addr, v) {
    switch (addr) {
      case 0xe000edf0:
        check((v >>> 16) === 0xa05f, 'DHCSR write without DBGKEY');
        this.dhcsr = v & 0xffff;
        if (v & 2) { this.halted = true; this.running = false; }
        else if (this.halted) this.resume();
        return;
      case 0xe000edfc: this.demcr = v; return;
      case 0xe000ed0c: if (v === 0x05fa0004) this.systemReset(); return;
      case 0x40023c04:
        this.keys.push(v >>> 0);
        if (this.keys.length === 2) {
          if (this.keys[0] === 0x45670123 && this.keys[1] === 0xcdef89ab) this.cr &= ~0x80000000;
          this.keys = [];
        }
        return;
      case 0x40023c0c: this.sr &= ~(v & 0x1f3); return;
      case 0x40023c10: {
        if (this.cr & 0x80000000) { this.sr |= 0x80; return; }   // PGSERR: locked
        this.cr = v >>> 0;
        if ((v & (1 << 16)) && (v & 2)) {
          const s = this.sectors[(v >> 3) & 0xf];
          this.flash.fill(0xff, s.start - FLASH_BASE, s.start - FLASH_BASE + s.size);
          this.erased.push(s.index);
        }
        return;
      }
      default:
        throw new Error(`simulator: unexpected write32 0x${addr.toString(16)}`);
    }
  }

  systemReset() {
    this.resetCount++;
    this.cr = 0x80000000;
    if (this.demcr & 1) { this.halted = true; this.running = false; }
    else if (!(this.dhcsr & 2) || !(this.dhcsr & 1)) { this.halted = false; this.running = true; }
    else this.halted = !!(this.dhcsr & 2);
  }

  // Resume from halt: the only code the host runs is the flash loader.
  resume() {
    this.halted = false;
    if (!(this.dhcsr & 1)) { this.running = true; return; }   // debug released
    const pc = this.regs[15];
    check(pc === SRAM, 'resumed somewhere other than the loader');
    check(F4_LOADER.every((b, i) => this.sram[i] === b), 'loader not in SRAM');
    check((this.cr & 0x301) === 0x201, 'loader run without PG and PSIZE=x32');
    let [src, dst, words] = [this.regs[0], this.regs[1], this.regs[2]];
    check(this.regs[3] === 0x40023c0c, 'loader r3 is not FLASH->SR');
    while (words) {
      const o = dst - FLASH_BASE;
      if (o < 0 || o + 4 > this.flash.length) { this.sr |= 0x10; break; }        // WRPERR
      for (let i = 0; i < 4; i++) {
        let byte = this.sram[src - SRAM + i];
        if (o + i === this.flakyAt) byte ^= 0x10;                               // stuck bit
        this.flash[o + i] &= byte;                                              // programming clears bits only
      }
      src += 4; dst += 4; words--;
    }
    this.regs[0] = src; this.regs[1] = dst; this.regs[2] = words;
    this.halted = true;                                                          // BKPT
  }
}
