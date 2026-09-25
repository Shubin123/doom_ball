// Instant flashing through the ST-Link debug probe on ST Nucleo / Discovery
// boards, over WebUSB. No BOOT0 jumper, reset button or serial adapter: the
// probe halts the core over SWD, erases and programs the STM32F4 flash with
// a small routine running in SRAM, verifies, and resets into the new image.
// The probe's USB serial port (the console) keeps working while it flashes.
//
// `usb` is a WebUSB USBDevice or anything with the same open /
// selectConfiguration / claimInterface / transferIn / transferOut methods.

export const STLINK_FILTERS = [
  { vendorId: 0x0483, productId: 0x3748 },   // ST-Link/V2
  { vendorId: 0x0483, productId: 0x374b },   // ST-Link/V2-1 (Nucleo-64, e.g. Nucleo-F401RE)
  { vendorId: 0x0483, productId: 0x374e },   // STLINK-V3
  { vendorId: 0x0483, productId: 0x374f },
  { vendorId: 0x0483, productId: 0x3752 },
  { vendorId: 0x0483, productId: 0x3753 },
  { vendorId: 0x0483, productId: 0x3754 },
];
export const isStLink = (dev) => STLINK_FILTERS.some((f) => f.vendorId === dev.vendorId && f.productId === dev.productId);

export class StLinkError extends Error {}

// STM32F4 parts with the single-bank 16/16/16/16/64/128… KB sector layout.
export const F4_CHIPS = {
  0x413: 'STM32F405/407', 0x419: 'STM32F42x/43x', 0x421: 'STM32F446', 0x423: 'STM32F401xB/C',
  0x431: 'STM32F411', 0x433: 'STM32F401xD/E', 0x441: 'STM32F412', 0x458: 'STM32F410',
};

export function f4Sectors(flashSize) {
  const sizes = [16, 16, 16, 16, 64].map((k) => k * 1024);
  while (sizes.reduce((a, b) => a + b, 0) < Math.min(flashSize, 1024 * 1024)) sizes.push(128 * 1024);
  let start = 0x08000000;
  return sizes.map((size, index) => { const s = { index, start, size }; start += size; return s; });
}

const CMD = { GET_VERSION: 0xf1, DEBUG: 0xf2, DFU: 0xf3, SWIM: 0xf4, GET_CURRENT_MODE: 0xf5 };
const DBG = {
  READMEM_32: 0x07, WRITEMEM_32: 0x08, EXIT: 0x21, ENTER: 0x30, READ_IDCODES: 0x31,
  READREG: 0x33, WRITEREG: 0x34, WRITE32: 0x35, READ32: 0x36, LAST_RW_STATUS: 0x3b,
  DRIVE_NRST: 0x3c, LAST_RW_STATUS2: 0x3e, SWD_SET_FREQ: 0x43,
};
const MODE = { DFU: 0, MASS: 1, DEBUG: 2, SWIM: 3 };
const OK = 0x80;

const DHCSR = 0xe000edf0, DEMCR = 0xe000edfc, AIRCR = 0xe000ed0c;
const DBGKEY = 0xa05f0000, C_DEBUGEN = 1, C_HALT = 2, C_MASKINTS = 8, S_HALT = 1 << 17;
const DBGMCU_IDCODE = 0xe0042000, F4_FLASH_SIZE = 0x1fff7a20;

const FLASH = 0x40023c00, KEYR = FLASH + 0x04, SR = FLASH + 0x0c, CR = FLASH + 0x10;
const SR_BSY = 1 << 16, SR_ERRORS = 0x1f2;
const CR_PG = 1, CR_SER = 2, CR_PSIZE32 = 2 << 8, CR_STRT = 1 << 16, CR_LOCK = 1 << 31;
const KEY1 = 0x45670123, KEY2 = 0xcdef89ab;

// ide/flash/stlink.js loader (arm-none-eabi-as): r0 = SRAM source, r1 = flash
// destination, r2 = word count, r3 = &FLASH->SR. Programs a word, waits for
// BSY, stops on an error bit, then BKPT. Returns the words left in r2.
//   loop: ldr r4,[r0],#4; str r4,[r1],#4; dsb
//   wait: ldr r4,[r3]; tst r4,#0x10000; bne wait; tst r4,#0xf2; bne done
//         subs r2,#1; bne loop
//   done: bkpt #0
export const F4_LOADER = Uint8Array.of(
  0x50, 0xf8, 0x04, 0x4b, 0x41, 0xf8, 0x04, 0x4b, 0xbf, 0xf3, 0x4f, 0x8f,
  0x1c, 0x68, 0x14, 0xf4, 0x80, 0x3f, 0xfb, 0xd1, 0x14, 0xf0, 0xf2, 0x0f,
  0x01, 0xd1, 0x01, 0x3a, 0xf0, 0xd1, 0x00, 0xbe);
const LOADER_ADDR = 0x20000000, BUFFER_ADDR = 0x20000400, BUFFER_SIZE = 16 * 1024;
const STACK_TOP = BUFFER_ADDR + BUFFER_SIZE + 0x400;
const USB_BLOCK = 1024;   // stay inside the 1 KB SWD address auto-increment window

const le32 = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
const u32 = (b, o = 0) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const hex = (v, n = 8) => `0x${(v >>> 0).toString(16).padStart(n, '0')}`;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class StLink {
  constructor(usb, log = () => {}, { timeoutMs = 3000 } = {}) {
    this.dev = usb;
    this.log = log;
    this.timeoutMs = timeoutMs;
  }

  // ---------------------------------------------------------------- USB --
  async open() {
    if (!this.dev.opened) await this.dev.open();
    if (this.dev.configuration === null) await this.dev.selectConfiguration(1);
    const intf = this.dev.configuration.interfaces.find((i) => i.alternates[0].interfaceClass === 0xff);
    if (!intf) throw new StLinkError('no ST-Link debug interface on this USB device');
    const eps = intf.alternates[0].endpoints.filter((e) => e.type === 'bulk');
    this.epOut = eps.find((e) => e.direction === 'out')?.endpointNumber;
    this.epIn = eps.filter((e) => e.direction === 'in').map((e) => e.endpointNumber).sort()[0];
    if (this.epOut == null || this.epIn == null) throw new StLinkError('ST-Link bulk endpoints not found');
    this.intf = intf.interfaceNumber;
    await this.dev.claimInterface(this.intf);
  }

  async close() {
    try { await this.cmd([CMD.DEBUG, DBG.EXIT]); } catch { /* probe gone */ }
    try { await this.dev.releaseInterface(this.intf); } catch { /* not claimed */ }
    try { await this.dev.close(); } catch { /* already closed */ }
  }

  async withTimeout(promise, what) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new StLinkError(`ST-Link did not answer (${what})`)), this.timeoutMs);
    });
    try { return await Promise.race([promise, timeout]); } finally { clearTimeout(timer); }
  }

  async cmd(bytes, inLength = 0, data = null) {
    const frame = new Uint8Array(16);
    frame.set(bytes);
    await this.withTimeout(this.dev.transferOut(this.epOut, frame), 'command');
    if (data) await this.withTimeout(this.dev.transferOut(this.epOut, data), 'data');
    if (!inLength) return null;
    const r = await this.withTimeout(this.dev.transferIn(this.epIn, inLength), 'reply');
    return new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength);
  }

  async debug(sub, args = [], inLength = 2) {
    const r = await this.cmd([CMD.DEBUG, sub, ...args], inLength);
    if (r[0] !== OK) throw new StLinkError(`ST-Link debug command 0x${sub.toString(16)} failed (status 0x${r[0].toString(16)})`);
    return r;
  }

  // ------------------------------------------------------------ connect --
  async connect() {
    await this.open();
    const v = await this.cmd([CMD.GET_VERSION], 6);
    const word = (v[0] << 8) | v[1];
    this.version = { stlink: word >> 12, jtag: (word >> 6) & 0x3f, msd: word & 0x3f };
    const name = this.version.stlink >= 3 ? `STLINK-V3 J${this.version.jtag}` : `ST-Link/V${this.version.stlink} J${this.version.jtag}`;
    if (this.version.stlink < 2 || (this.version.stlink === 2 && this.version.jtag < 15)) {
      throw new StLinkError(`${name} firmware is too old; update it with ST's ST-LinkUpgrade`);
    }

    const [mode] = await this.cmd([CMD.GET_CURRENT_MODE], 2);
    if (mode === MODE.DFU) await this.cmd([CMD.DFU, 0x07]);
    else if (mode === MODE.SWIM) await this.cmd([CMD.SWIM, 0x01]);
    else if (mode === MODE.DEBUG) await this.cmd([CMD.DEBUG, DBG.EXIT]);

    if (this.version.stlink === 2) await this.debug(DBG.SWD_SET_FREQ, [1]);   // 1.8 MHz
    let idcode = await this.enterSwd();
    if (!idcode) {
      // Firmware that sleeps or reuses the SWD pins: attach while NRST is held low.
      this.log('ST-Link: no SWD response, connecting under reset');
      await this.debug(DBG.DRIVE_NRST, [0]);
      await pause(20);
      idcode = await this.enterSwd();
      if (idcode) {
        await this.write32(DHCSR, DBGKEY | C_HALT | C_DEBUGEN);
        await this.write32(DEMCR, (await this.read32(DEMCR)) | 1);   // halt again at the reset vector
      }
      await this.debug(DBG.DRIVE_NRST, [1]);
      if (!idcode) throw new StLinkError('no target answers on SWD; is the board powered and the CN2 jumpers fitted?');
    }

    this.chipId = (await this.read32(DBGMCU_IDCODE)) & 0xfff;
    this.chip = F4_CHIPS[this.chipId];
    if (!this.chip) throw new StLinkError(`target ${hex(this.chipId, 3)} is not a supported STM32F4 (instant flash supports F401/F411/F4xx)`);
    this.flashSize = ((await this.read32(F4_FLASH_SIZE)) >>> 16) * 1024;
    this.sectors = f4Sectors(this.flashSize);
    this.log(`${name}: ${this.chip} (id ${hex(this.chipId, 3)}), ${this.flashSize / 1024} KB flash, SWD ${hex(idcode)}`);
    return { chipId: this.chipId, chip: this.chip, flashSize: this.flashSize, probe: name };
  }

  async enterSwd() {
    try {
      await this.debug(DBG.ENTER, [0xa3]);
      const r = await this.debug(DBG.READ_IDCODES, [], 12);
      return u32(r, 4);
    } catch {
      return 0;
    }
  }

  // ------------------------------------------------------------- memory --
  async read32(addr) {
    return u32(await this.debug(DBG.READ32, le32(addr), 8), 4);
  }

  async write32(addr, value) {
    await this.debug(DBG.WRITE32, [...le32(addr), ...le32(value)]);
  }

  async lastRwStatus() {
    const v2 = this.version.stlink >= 3 || this.version.jtag >= 15;
    const r = await this.cmd([CMD.DEBUG, v2 ? DBG.LAST_RW_STATUS2 : DBG.LAST_RW_STATUS], v2 ? 12 : 2);
    if (r[0] !== OK) throw new StLinkError(`SWD memory access fault (status 0x${r[0].toString(16)})`);
  }

  async readMem(addr, length) {
    const out = new Uint8Array(length);
    for (let off = 0; off < length;) {
      const n = Math.min(USB_BLOCK - ((addr + off) % USB_BLOCK), length - off);
      const r = await this.cmd([CMD.DEBUG, DBG.READMEM_32, ...le32(addr + off), n & 0xff, n >> 8], n);
      if (r.length !== n) throw new StLinkError(`short read at ${hex(addr + off)}`);
      await this.lastRwStatus();
      out.set(r, off);
      off += n;
    }
    return out;
  }

  async writeMem(addr, data) {
    for (let off = 0; off < data.length;) {
      const n = Math.min(USB_BLOCK - ((addr + off) % USB_BLOCK), data.length - off);
      await this.cmd([CMD.DEBUG, DBG.WRITEMEM_32, ...le32(addr + off), n & 0xff, n >> 8], 0, data.subarray(off, off + n));
      await this.lastRwStatus();
      off += n;
    }
  }

  async writeReg(index, value) {
    await this.debug(DBG.WRITEREG, [index, ...le32(value)]);
  }

  async readReg(index) {
    return u32(await this.debug(DBG.READREG, [index], 8), 4);
  }

  // --------------------------------------------------------------- core --
  async waitHalted(what, timeoutMs = 2000) {
    const until = Date.now() + timeoutMs;
    for (;;) {
      let dhcsr = 0;
      try { dhcsr = await this.read32(DHCSR); } catch { /* core busy resetting */ }
      if (dhcsr & S_HALT) return;
      if (Date.now() > until) throw new StLinkError(`core did not halt (${what})`);
      await pause(2);
    }
  }

  // Halt at the reset vector so no application code runs while flashing.
  async resetHalt() {
    await this.write32(DHCSR, DBGKEY | C_HALT | C_DEBUGEN);
    await this.write32(DEMCR, (await this.read32(DEMCR)) | 1);    // VC_CORERESET
    await this.write32(AIRCR, 0x05fa0004).catch(() => {});        // SYSRESETREQ
    await pause(20);
    await this.waitHalted('reset');
  }

  async resetRun() {
    await this.write32(DEMCR, (await this.read32(DEMCR)) & ~1);
    await this.write32(AIRCR, 0x05fa0004).catch(() => {});
    await pause(20);
    await this.write32(DHCSR, DBGKEY).catch(() => {});           // release debug; core runs
  }

  // -------------------------------------------------------------- flash --
  async flashWait(what, timeoutMs) {
    const until = Date.now() + timeoutMs;
    for (;;) {
      const sr = await this.read32(SR);
      if (!(sr & SR_BSY)) {
        if (sr & SR_ERRORS) throw new StLinkError(`flash ${what} failed (FLASH_SR ${hex(sr)})`);
        return;
      }
      if (Date.now() > until) throw new StLinkError(`flash ${what} timed out`);
      await pause(5);
    }
  }

  async unlock() {
    if (!((await this.read32(CR)) & CR_LOCK)) return;
    await this.write32(KEYR, KEY1);
    await this.write32(KEYR, KEY2);
    if ((await this.read32(CR)) & CR_LOCK) throw new StLinkError('flash stayed locked (read protection set?)');
  }

  async eraseSector(sector) {
    await this.write32(CR, CR_SER | CR_PSIZE32 | (sector.index << 3));
    await this.write32(CR, CR_SER | CR_PSIZE32 | (sector.index << 3) | CR_STRT);
    await this.flashWait(`erase of sector ${sector.index}`, 10000);
  }

  async program(addr, data) {
    await this.writeMem(BUFFER_ADDR, data);
    await this.writeReg(0, BUFFER_ADDR);
    await this.writeReg(1, addr);
    await this.writeReg(2, data.length / 4);
    await this.writeReg(3, SR);
    await this.writeReg(13, STACK_TOP);
    await this.writeReg(15, LOADER_ADDR);
    await this.writeReg(16, 0x01000000);                        // xPSR: Thumb
    await this.write32(DHCSR, DBGKEY | C_MASKINTS | C_DEBUGEN); // run until BKPT
    await this.waitHalted(`programming ${hex(addr)}`, 5000);
    const left = await this.readReg(2);
    const sr = await this.read32(SR);
    if (left || (sr & SR_ERRORS)) throw new StLinkError(`programming stopped at ${hex(addr + (data.length / 4 - left) * 4)} (FLASH_SR ${hex(sr)})`);
  }

  async flash(image, { base = 0x08000000, onProgress = () => {}, verify = true, start = true } = {}) {
    if (!this.sectors) throw new StLinkError('connect() first');
    if (!image.length || base + image.length > 0x08000000 + this.flashSize) {
      throw new StLinkError(`image of ${image.length} bytes does not fit in ${this.flashSize / 1024} KB flash`);
    }
    const padded = new Uint8Array((image.length + 3) & ~3).fill(0xff);
    padded.set(image);
    const end = base + padded.length;
    const sectors = this.sectors.filter((s) => s.start < end && s.start + s.size > base);

    await this.resetHalt();
    await this.writeMem(LOADER_ADDR, F4_LOADER);
    await this.unlock();
    await this.write32(SR, SR_ERRORS | 1);                      // clear stale flags
    try {
      this.log(`erasing ${sectors.length} sector${sectors.length === 1 ? '' : 's'} (${sectors.reduce((a, s) => a + s.size, 0) / 1024} KB)`);
      for (let i = 0; i < sectors.length; i++) {
        onProgress('erase', i, sectors.length);
        await this.eraseSector(sectors[i]);
      }
      onProgress('erase', sectors.length, sectors.length);
      await this.write32(CR, CR_PG | CR_PSIZE32);
      for (let off = 0; off < padded.length; off += BUFFER_SIZE) {
        await this.program(base + off, padded.subarray(off, off + BUFFER_SIZE));
        onProgress('write', Math.min(off + BUFFER_SIZE, padded.length), padded.length);
      }
    } finally {
      await this.write32(CR, CR_LOCK).catch(() => {});
    }

    if (verify) {
      for (let off = 0; off < image.length; off += BUFFER_SIZE) {
        const want = image.subarray(off, off + BUFFER_SIZE);
        const got = await this.readMem(base + off, (want.length + 3) & ~3);
        for (let i = 0; i < want.length; i++) {
          if (got[i] !== want[i]) throw new StLinkError(`verify failed at ${hex(base + off + i)}: wrote 0x${want[i].toString(16)}, read 0x${got[i].toString(16)}`);
        }
        onProgress('verify', Math.min(off + BUFFER_SIZE, image.length), image.length);
      }
      this.log(`verified ${image.length} bytes`);
    }
    if (start) {
      await this.resetRun();
      this.log('reset: running the new firmware');
    }
  }
}
