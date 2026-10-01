// Simulated ST-Link probes wired to an STM32, with the WebUSB device surface
// the ST-Link flasher uses: an ST-Link/V2-1 + STM32F401RE (a Nucleo-F401RE)
// by default, or an STLINK-V3 + STM32H743 with `{ family: 'h7' }`. Shared by
// tests/stlink.test.mjs and the headless-Chrome IDE tests, so it avoids
// Node-only modules.
import { F4_LOADER, H7_LOADER, f4Sectors, h7Sectors } from '../ide/flash/stlink.js';

const le32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
function check(condition, message = 'simulator: protocol violation') {
  if (!condition) throw new Error(message);
}
export function pattern(size, seed) {
  const img = new Uint8Array(size);
  for (let i = 0; i < img.length; i++) img[i] = (i * 7 + seed + (i >> 8)) & 0xff;
  return img;
}

const FLASH_BASE = 0x08000000;

const FAMILIES = {
  f4: {
    productId: 0x374b, version: [0x2c, 0x23, 0x83, 0x04, 0x4b, 0x37],   // V2 J35 M3
    chipId: 0x433, flashKb: 512, cpuid: 0x410fc241, idcode: 0xe0042000,
    sizeAddr: 0x1fff7a20, sizeWord: (kb) => (kb << 16) >>> 0,
    ram: 0x20000000, ramKb: 96, loader: F4_LOADER, sectors: f4Sectors, unit: 4,
  },
  h7: {
    productId: 0x3754, version: [0x30, 0x00, 0x83, 0x04, 0x54, 0x37],   // V3 (J in GET_VERSION_V3)
    chipId: 0x450, flashKb: 2048, cpuid: 0x411fc271, idcode: 0x5c001000,
    sizeAddr: 0x1ff1e880, sizeWord: (kb) => (0xffff0000 | kb) >>> 0,
    ram: 0x24000000, ramKb: 512, loader: H7_LOADER, sectors: h7Sectors, unit: 32,
  },
};

// H7 flash controller registers, per bank at 0x52002000 + 0x100 * bank.
const H7_FLASH = 0x52002000, H7_ERRORS = 0x07ee0000;

export class SimStLink {
  constructor({ family = 'f4', chipId, flashKb, swdAsleep = false, flakyAt = -1, volts = 3.3,
    busy = false, unplugAfter = -1 } = {}) {
    const fam = FAMILIES[family];
    this.family = family; this.fam = fam;
    this.vendorId = 0x0483; this.productId = fam.productId;
    this.productName = family === 'h7' ? 'STLINK-V3' : 'STM32 STLink';
    this.opened = false; this.configuration = null;
    this.mode = 1;                              // mass storage, as after plug-in
    this.chipId = chipId ?? fam.chipId; this.flashKb = flashKb ?? fam.flashKb;
    this.flash = pattern(this.flashKb * 1024, 99);   // old firmware, not erased
    this.ram = fam.ram;
    this.sram = new Uint8Array(fam.ramKb * 1024);
    this.sectors = fam.sectors(this.flashKb * 1024);
    this.erased = [];
    this.swdAsleep = swdAsleep; this.nrstLow = false; this.flakyAt = flakyAt;
    this.volts = volts; this.busy = busy; this.unplugAfter = unplugAfter; this.transfers = 0;
    this.regs = new Uint32Array(20);
    this.halted = false; this.resetCount = 0; this.running = true;
    this.dhcsr = 0; this.demcr = 0;
    // F4: one controller. H7: CR reset value LOCK | PSIZE x64 per bank.
    this.cr = 0x80000000; this.sr = 0; this.keys = [];
    this.bank = [0, 1].map(() => ({ cr: 0x31, sr: 0, keys: [] }));
    this.pending = null; this.reply = null; this.rwStatus = 0x80;
  }
  // WebUSB surface
  async open() {
    if (this.busy) throw Object.assign(new Error('Access denied.'), { name: 'SecurityError' });
    this.opened = true;
  }
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
  unplugged() {
    if (this.unplugAfter >= 0 && ++this.transfers > this.unplugAfter) {
      this.opened = false; this.claimed = false;
      throw Object.assign(new Error('A transfer error has occurred.'), { name: 'NetworkError' });
    }
  }
  async transferOut(ep, data) {
    this.unplugged();
    check(ep === 1, `wrong endpoint ${ep}`);
    const b = new Uint8Array(data);
    if (this.pending) { this.pending(b); this.pending = null; return { status: 'ok' }; }
    check(b.length === 16, 'ST-Link commands are 16-byte frames');
    this.command(b);
    return { status: 'ok' };
  }
  async transferIn(ep, length) {
    this.unplugged();
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
    if (c[0] === 0xf1) return out(...this.fam.version);
    if (c[0] === 0xfb) { check(this.family === 'h7', 'GET_VERSION_V3 sent to a V2 probe'); return out(3, 0, 17, 4, 3, 0, 0, 0, 0x83, 0x04, 0x54, 0x37); }
    if (c[0] === 0xf5) return out(this.mode, 0);
    if (c[0] === 0xf7) { const ref = 1600; return out(...val(ref), ...val(Math.round(this.volts * ref / 2.4))); }
    if (c[0] !== 0xf2) return;
    const addr = le32(c, 2);
    switch (c[1]) {
      case 0x21: this.mode = 1; return;
      case 0x30: this.mode = 2; return out(0x80, 0);
      case 0x43: check(this.family !== 'h7', 'V2 SWD frequency command sent to a V3 probe'); return out(0x80, 0);
      case 0x3c: this.nrstLow = c[2] === 0; if (!this.nrstLow) this.systemReset(); return out(0x80, 0);
      case 0x31: return this.swdUp() ? out(0x80, 0, 0, 0, ...val(0x2ba01477), 0, 0, 0, 0) : out(0x81, ...new Array(11).fill(0));
      case 0x36: { const ok = this.swdUp(); return out(this.status(ok), 0, 0, 0, ...val(ok ? this.read32(addr) : 0)); }
      case 0x35: { const ok = this.swdUp(); if (ok) this.write32(addr, le32(c, 6)); return out(this.status(ok), 0); }
      case 0x33: check(this.halted, 'register read while running'); return out(0x80, 0, 0, 0, ...val(this.regs[c[2]]));
      case 0x34: check(this.halted, 'register write while running'); this.regs[c[2]] = le32(c, 3); return out(0x80, 0);
      case 0x3e: { const s = this.rwStatus; this.rwStatus = 0x80; return out(s, ...new Array(11).fill(0)); }
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
    if (addr >= this.ram && addr + n <= this.ram + this.sram.length) return this.sram.slice(addr - this.ram, addr - this.ram + n);
    this.rwStatus = 0x81;
    return new Uint8Array(n);
  }
  writeBytes(addr, data) {
    check(addr >= this.ram && addr + data.length <= this.ram + this.sram.length, `debugger bulk write outside SRAM at 0x${addr.toString(16)}`);
    this.sram.set(data, addr - this.ram);
  }

  read32(addr) {
    const fam = this.fam;
    if (addr === 0xe000ed00) return fam.cpuid;
    if (addr === fam.idcode) return 0x10000000 | this.chipId;
    if (addr === fam.sizeAddr) return fam.sizeWord(this.flashKb);
    if (addr === 0xe000edf0) return (this.dhcsr & 0xffff) | (this.halted ? 1 << 17 : 0);
    if (addr === 0xe000edfc) return this.demcr;
    if (this.family === 'f4') {
      if (addr === 0x40023c0c) return this.sr;
      if (addr === 0x40023c10) return this.cr;
    } else if (addr >= H7_FLASH && addr < H7_FLASH + 0x200) {
      const b = this.bank[(addr - H7_FLASH) >> 8], reg = addr & 0xff;
      if (reg === 0x0c) return b.cr;
      if (reg === 0x10) return b.sr;
    }
    return le32(this.readBytes(addr, 4), 0);
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
    }
    if (this.family === 'h7') return this.writeH7(addr, v >>> 0);
    switch (addr) {
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

  writeH7(addr, v) {
    check(addr >= H7_FLASH && addr < H7_FLASH + 0x200, `simulator: unexpected write32 0x${addr.toString(16)}`);
    const bankNo = (addr - H7_FLASH) >> 8, b = this.bank[bankNo];
    switch (addr & 0xff) {
      case 0x04:
        b.keys.push(v);
        if (b.keys.length === 2) {
          if (b.keys[0] === 0x45670123 && b.keys[1] === 0xcdef89ab) b.cr &= ~1;
          b.keys = [];
        }
        return;
      case 0x14: b.sr &= ~(v & (H7_ERRORS | 1 << 16)); return;
      case 0x0c: {
        if (b.cr & 1) { b.sr |= 1 << 18; return; }               // PGSERR: locked
        b.cr = v;
        if ((v & (1 << 7)) && (v & 4)) {                         // START with SER
          check(((v >> 4) & 3) === Math.round(this.volts >= 2.7 ? 3 : 2), 'erase PSIZE does not match the supply');
          const s = this.sectors.find((x) => x.bank === bankNo && x.snb === ((v >> 8) & 7));
          check(s, 'erase of a sector that does not exist');
          this.flash.fill(0xff, s.start - FLASH_BASE, s.start - FLASH_BASE + s.size);
          this.erased.push(s.index);
          b.cr &= ~(1 << 7);
          b.sr |= 1 << 16;                                       // EOP
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
    for (const b of this.bank) b.cr |= 1;
    if (this.demcr & 1) { this.halted = true; this.running = false; }
    else if (!(this.dhcsr & 2) || !(this.dhcsr & 1)) { this.halted = false; this.running = true; }
    else this.halted = !!(this.dhcsr & 2);
  }

  // Resume from halt: the only code the host runs is the flash loader.
  resume() {
    this.halted = false;
    if (!(this.dhcsr & 1)) { this.running = true; return; }   // debug released
    const pc = this.regs[15], ram = this.ram;
    check(pc === ram, 'resumed somewhere other than the loader');
    check(this.fam.loader.every((b, i) => this.sram[i] === b), 'loader not in SRAM');
    let [src, dst, count] = [this.regs[0], this.regs[1], this.regs[2]];
    const unit = this.fam.unit;
    let bank = null;
    if (this.family === 'f4') {
      check((this.cr & 0x301) === 0x201, 'loader run without PG and PSIZE=x32');
      check(this.regs[3] === 0x40023c0c, 'loader r3 is not FLASH->SR');
    } else {
      const bankNo = (this.regs[3] - H7_FLASH) >> 8;
      check(this.regs[3] === H7_FLASH + 0x10 + bankNo * 0x100 && bankNo >= 0 && bankNo < 2, 'loader r3 is not FLASH->SRx');
      check(this.regs[6] === H7_ERRORS, 'loader r6 is not the FLASH_SR error mask');
      bank = this.bank[bankNo];
      check(bank.cr & 2 && !(bank.cr & 1), 'loader run without PG on an unlocked bank');
    }
    while (count) {
      const o = dst - FLASH_BASE;
      if (o < 0 || o + unit > this.flash.length) { if (bank) bank.sr |= 1 << 17; else this.sr |= 0x10; break; }   // WRPERR
      if (bank) {
        const inBank = this.sectors.find((s) => s.start <= dst && dst < s.start + s.size);
        check(o % 32 === 0, 'H7 flash word not 32-byte aligned');
        check(inBank && this.bank[inBank.bank] === bank, 'loader programs a bank through the other bank\'s SR');
        if (!this.flash.subarray(o, o + unit).every((x) => x === 0xff)) { bank.sr |= 1 << 21; break; }   // not erased
      }
      for (let i = 0; i < unit; i++) {
        let byte = this.sram[src - ram + i];
        if (o + i === this.flakyAt) byte ^= 0x10;                               // stuck bit
        this.flash[o + i] &= byte;                                              // programming clears bits only
      }
      src += unit; dst += unit; count--;
    }
    this.regs[0] = src; this.regs[1] = dst; this.regs[2] = count;
    this.halted = true;                                                          // BKPT
  }
}
