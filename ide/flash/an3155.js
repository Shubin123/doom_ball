// STM32 ROM UART bootloader (ST application note AN3155).
//
// Works for both targets over USART1 (PA9 TX / PA10 RX) with BOOT0 high:
//   STM32F103C8 (Blue Pill)  PID 0x410, 1 KB pages,   Erase (0x43)
//   STM32H743                PID 0x450, 128 KB sectors, Extended Erase (0x44)
//
// The transport is anything with write(Uint8Array) and read(n, timeoutMs);
// webSerialTransport() adapts a Web Serial port (8E1, even parity).

const ACK = 0x79;
const NACK = 0x1f;

export const CHIPS = {
  0x410: { name: 'STM32F103 (medium density)', flashBase: 0x08000000, eraseUnit: 1024 },
  0x450: { name: 'STM32H743/753', flashBase: 0x08000000, eraseUnit: 128 * 1024, writeAlign: 32 },
};

export class BootloaderError extends Error {}

export class An3155 {
  constructor(transport, log = () => {}) {
    this.t = transport;
    this.log = log;
    this.commands = [];
  }

  async ack(timeout = 1000, what = 'command') {
    const b = (await this.t.read(1, timeout))[0];
    if (b === ACK) return;
    if (b === NACK) throw new BootloaderError(`${what}: NACK from bootloader`);
    throw new BootloaderError(`${what}: unexpected byte 0x${b.toString(16)}`);
  }

  async sendCommand(cmd, timeout) {
    await this.t.write(Uint8Array.of(cmd, cmd ^ 0xff));
    await this.ack(timeout, `command 0x${cmd.toString(16)}`);
  }

  static withChecksum(bytes) {
    let x = 0;
    for (const b of bytes) x ^= b;
    return Uint8Array.from([...bytes, x]);
  }

  async sendAddress(addr) {
    const a = [(addr >>> 24) & 0xff, (addr >>> 16) & 0xff, (addr >>> 8) & 0xff, addr & 0xff];
    await this.t.write(An3155.withChecksum(a));
    await this.ack(1000, 'address');
  }

  async connect() {
    // 0x7F lets the bootloader measure the baud rate. If it was already
    // synchronised it answers NACK (or nothing), which is also fine.
    await this.t.write(Uint8Array.of(0x7f));
    try {
      await this.ack(500, 'sync');
    } catch (e) {
      if (!(e instanceof BootloaderError) && !/timeout/i.test(e.message)) throw e;
    }
    await this.get();
    this.pid = await this.getId();
    this.chip = CHIPS[this.pid];
    this.log(`bootloader v${this.version >> 4}.${this.version & 15}, chip ID 0x${this.pid.toString(16)}` +
      (this.chip ? ` (${this.chip.name})` : ' (unknown)'));
    if (!this.chip) throw new BootloaderError(`unsupported chip ID 0x${this.pid.toString(16)}`);
    return this.chip;
  }

  async get() {
    await this.sendCommand(0x00);
    const n = (await this.t.read(1, 1000))[0];
    const data = await this.t.read(n + 1, 1000);
    await this.ack();
    this.version = data[0];
    this.commands = Array.from(data.slice(1));
  }

  async getId() {
    await this.sendCommand(0x02);
    const n = (await this.t.read(1, 1000))[0];
    const id = await this.t.read(n + 1, 1000);
    await this.ack();
    return (id[0] << 8) | id[1];
  }

  async readMemory(addr, length) {
    await this.sendCommand(0x11);
    await this.sendAddress(addr);
    await this.t.write(Uint8Array.of(length - 1, (length - 1) ^ 0xff));
    await this.ack(1000, 'read length');
    return this.t.read(length, 2000);
  }

  async writeMemory(addr, data) {
    await this.sendCommand(0x31);
    await this.sendAddress(addr);
    const frame = new Uint8Array(data.length + 2);
    frame[0] = data.length - 1;
    frame.set(data, 1);
    let x = frame[0];
    for (const b of data) x ^= b;
    frame[frame.length - 1] = x;
    await this.t.write(frame);
    await this.ack(2000, `write at 0x${addr.toString(16)}`);
  }

  // Erases the erase units (pages or sectors) covering [base, base + length).
  async erase(length) {
    const unit = this.chip.eraseUnit;
    const count = Math.ceil(length / unit);
    const pages = Array.from({ length: count }, (_, i) => i);
    if (this.commands.includes(0x44)) {
      await this.sendCommand(0x44);
      const frame = [((count - 1) >> 8) & 0xff, (count - 1) & 0xff];
      for (const p of pages) frame.push((p >> 8) & 0xff, p & 0xff);
      let x = 0;
      for (const b of frame) x ^= b;
      await this.t.write(Uint8Array.from([...frame, x]));
      await this.ack(count * 4000 + 10000, 'extended erase');
    } else {
      await this.sendCommand(0x43);
      const frame = [count - 1, ...pages];
      let x = 0;
      for (const b of frame) x ^= b;
      await this.t.write(Uint8Array.from([...frame, x]));
      await this.ack(count * 100 + 5000, 'erase');
    }
  }

  async go(addr) {
    await this.sendCommand(0x21);
    await this.sendAddress(addr);
  }

  // Erase, program, verify and start `image` at the start of flash.
  async flash(image, { onProgress = () => {}, verify = true, start = true } = {}) {
    const chip = this.chip || (await this.connect());
    const base = chip.flashBase;
    const align = chip.writeAlign || 4;
    const padded = new Uint8Array(Math.ceil(image.length / align) * align).fill(0xff);
    padded.set(image);

    this.log(`erasing ${Math.ceil(padded.length / chip.eraseUnit)} x ${chip.eraseUnit / 1024} KB`);
    onProgress('erase', 0, 1);
    await this.erase(padded.length);
    onProgress('erase', 1, 1);

    for (let off = 0; off < padded.length; off += 256) {
      await this.writeMemory(base + off, padded.subarray(off, Math.min(off + 256, padded.length)));
      onProgress('write', Math.min(off + 256, padded.length), padded.length);
    }

    if (verify) {
      for (let off = 0; off < image.length; off += 256) {
        const n = Math.min(256, image.length - off);
        const got = await this.readMemory(base + off, n);
        for (let i = 0; i < n; i++) {
          if (got[i] !== image[off + i]) {
            throw new BootloaderError(`verify failed at 0x${(base + off + i).toString(16)}`);
          }
        }
        onProgress('verify', off + n, image.length);
      }
    }
    if (start) {
      await this.go(base);
      this.log('started application');
    }
  }
}

// Adapts a Web Serial SerialPort (already requested by the page).
export async function webSerialTransport(port, baudRate = 115200) {
  await port.open({ baudRate, dataBits: 8, parity: 'even', stopBits: 1 });
  const writer = port.writable.getWriter();
  const reader = port.readable.getReader();
  let buf = new Uint8Array(0);
  let pending = null;

  const pump = async () => {
    const { value, done } = await reader.read();
    if (done) throw new Error('serial port closed');
    const next = new Uint8Array(buf.length + value.length);
    next.set(buf);
    next.set(value, buf.length);
    buf = next;
  };

  return {
    async write(bytes) {
      await writer.write(bytes);
    },
    async read(n, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      while (buf.length < n) {
        const left = deadline - Date.now();
        if (left <= 0) throw new Error(`timeout waiting for ${n} byte(s)`);
        pending = pending || pump().finally(() => { pending = null; });
        await Promise.race([pending, new Promise((r) => setTimeout(r, left))]);
      }
      const out = buf.slice(0, n);
      buf = buf.slice(n);
      return out;
    },
    async close() {
      reader.cancel().catch(() => {});
      reader.releaseLock();
      writer.releaseLock();
      await port.close();
    },
  };
}
