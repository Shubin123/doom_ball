// STM32 ROM USB DFU bootloader (DfuSe, ST's DFU 1.1a extensions) over WebUSB.
//
// The STM32H743 enumerates as 0483:DF11 on PA11/PA12 when started with
// BOOT0 high. (The STM32F103's ROM has no USB bootloader; use AN3155.)
//
// `usb` is a WebUSB USBDevice or anything with the same open /
// selectConfiguration / claimInterface / controlTransferIn/Out methods.

const DNLOAD = 1, GETSTATUS = 3, CLRSTATUS = 4, ABORT = 6;
const STATE = { IDLE: 2, DNBUSY: 4, DNLOAD_IDLE: 5, MANIFEST: 7, ERROR: 10 };

export const DFU_FILTERS = [{ vendorId: 0x0483, productId: 0xdf11 }];

export class DfuError extends Error {}

// "@Internal Flash  /0x08000000/16*128Kg" -> [{ start, sectorSize, count }]
export function parseDfuseLayout(name) {
  const m = /\/\s*(0x[0-9a-fA-F]+)\s*\/(.*)$/.exec(name);
  if (!m) return null;
  let addr = parseInt(m[1], 16);
  const segments = [];
  // Several banks can follow as "/0x08100000/8*128Kg"
  for (const part of m[2].split('/')) {
    if (/^0x/i.test(part.trim())) {
      addr = parseInt(part.trim(), 16);
      continue;
    }
    for (const seg of part.split(',')) {
      const s = /(\d+)\s*\*\s*(\d+)\s*([KM]?)\s*([a-g])?/.exec(seg.trim());
      if (!s) continue;
      const mult = s[3] === 'K' ? 1024 : s[3] === 'M' ? 1024 * 1024 : 1;
      const size = parseInt(s[2], 10) * mult;
      const count = parseInt(s[1], 10);
      segments.push({ start: addr, sectorSize: size, count, attrs: s[4] || '' });
      addr += size * count;
    }
  }
  return segments;
}

export class DfuSe {
  constructor(usb, log = () => {}) {
    this.dev = usb;
    this.log = log;
    this.transferSize = 1024;
  }

  async open() {
    await this.dev.open();
    if (this.dev.configuration === null) await this.dev.selectConfiguration(1);

    const alts = [];
    for (const intf of this.dev.configuration.interfaces) {
      for (const alt of intf.alternates) {
        if (alt.interfaceClass === 0xfe && alt.interfaceSubclass === 0x01) {
          alts.push({ intf: intf.interfaceNumber, alt: alt.alternateSetting, name: alt.interfaceName || '' });
        }
      }
    }
    const flash = alts.find((a) => /flash/i.test(a.name)) || alts[0];
    if (!flash) throw new DfuError('no DFU interface found');
    this.intf = flash.intf;
    await this.dev.claimInterface(this.intf);
    await this.dev.selectAlternateInterface(this.intf, flash.alt);
    this.layout = parseDfuseLayout(flash.name) || [
      { start: 0x08000000, sectorSize: 128 * 1024, count: 16, attrs: 'g' },
    ];
    this.transferSize = (await this.readTransferSize()) || this.transferSize;
    this.log(`DFU: ${flash.name.trim() || 'internal flash'}, transfer size ${this.transferSize}`);
    await this.clearErrors();
  }

  async readTransferSize() {
    try {
      const r = await this.dev.controlTransferIn(
        { requestType: 'standard', recipient: 'device', request: 6, value: 0x0200, index: 0 }, 1024);
      const d = new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength);
      for (let i = 0; i + 1 < d.length && d[i] > 0; i += d[i]) {
        if (d[i + 1] === 0x21 && d[i] >= 7) return d[i + 5] | (d[i + 6] << 8);   // DFU functional
      }
    } catch { /* fall back to default */ }
    return 0;
  }

  async out(request, value, data) {
    const r = await this.dev.controlTransferOut(
      { requestType: 'class', recipient: 'interface', request, value, index: this.intf }, data);
    if (r.status !== 'ok') throw new DfuError(`control OUT ${request} failed: ${r.status}`);
  }

  async getStatus() {
    const r = await this.dev.controlTransferIn(
      { requestType: 'class', recipient: 'interface', request: GETSTATUS, value: 0, index: this.intf }, 6);
    const d = new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength);
    return { status: d[0], pollMs: d[1] | (d[2] << 8) | (d[3] << 16), state: d[4] };
  }

  async clearErrors() {
    let s = await this.getStatus();
    if (s.state === STATE.ERROR) {
      await this.out(CLRSTATUS, 0);
      s = await this.getStatus();
    }
    if (s.state !== STATE.IDLE && s.state !== STATE.DNLOAD_IDLE) {
      await this.out(ABORT, 0);
    }
  }

  // Sends a DNLOAD and waits until the device has finished it.
  async download(blockNum, data) {
    await this.out(DNLOAD, blockNum, data);
    for (;;) {
      const s = await this.getStatus();
      if (s.status !== 0) throw new DfuError(`DFU status error ${s.status} (state ${s.state})`);
      if (s.state === STATE.DNLOAD_IDLE || s.state === STATE.IDLE) return s;
      if (s.state === STATE.MANIFEST) return s;
      if (s.state === STATE.ERROR) throw new DfuError('device entered dfuERROR');
      await new Promise((r) => setTimeout(r, Math.max(s.pollMs, 1)));
    }
  }

  static addrCommand(cmd, addr) {
    return Uint8Array.of(cmd, addr & 0xff, (addr >>> 8) & 0xff, (addr >>> 16) & 0xff, (addr >>> 24) & 0xff);
  }

  async setAddress(addr) {
    await this.download(0, DfuSe.addrCommand(0x21, addr));
  }

  async eraseSector(addr) {
    await this.download(0, DfuSe.addrCommand(0x41, addr));
  }

  sectorsFor(start, length) {
    const out = [];
    for (const seg of this.layout) {
      for (let i = 0; i < seg.count; i++) {
        const a = seg.start + i * seg.sectorSize;
        if (a < start + length && a + seg.sectorSize > start) out.push(a);
      }
    }
    return out;
  }

  async flash(image, { base = 0x08000000, onProgress = () => {}, start = true } = {}) {
    // The H7 programs 256-bit flash words: pad the tail with erased bytes.
    const padded = new Uint8Array(Math.ceil(image.length / 32) * 32).fill(0xff);
    padded.set(image);
    image = padded;
    const sectors = this.sectorsFor(base, image.length);
    for (let i = 0; i < sectors.length; i++) {
      await this.eraseSector(sectors[i]);
      onProgress('erase', i + 1, sectors.length);
    }
    this.log(`erased ${sectors.length} sector(s)`);

    for (let off = 0; off < image.length; off += this.transferSize) {
      await this.setAddress(base + off);
      await this.download(2, image.subarray(off, Math.min(off + this.transferSize, image.length)));
      onProgress('write', Math.min(off + this.transferSize, image.length), image.length);
    }

    if (start) {
      // Zero-length DNLOAD after setting the address = leave DFU and jump.
      await this.setAddress(base);
      await this.out(DNLOAD, 0, new Uint8Array(0));
      try {
        await this.getStatus();     // triggers manifestation; the device resets
      } catch { /* device disconnects while resetting */ }
      this.log('left DFU mode, application starting');
    }
  }
}
