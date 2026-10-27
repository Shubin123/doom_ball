// Wire formats of the DOOM balloon, ported from the UVic Satellite Design
// repositories so the browser speaks exactly what the hardware does:
//   downlink frames  uvsd-nrf-doom  nrfdoom/source/n_frame_uart.c (encoder, PR #12:
//                                   4-byte LENGTH; master's 2-byte one wraps on busy frames)
//                    uvsd-doom-gs   ground_station/serial_rx.py   (parser, PR #10)
//   uplink keyboard  uvsd-doom-gs   ground_station/messages.py, hid.py
// tests/balloon_protocol.test.mjs checks them against the Python originals.

export const FRAME_SYNC0 = 0xaa;
export const FRAME_SYNC1 = 0x55;
export const FRAME_TYPE_DOOM_FRAME = 0x02;
export const SCREEN_WIDTH = 320;
export const SCREEN_HEIGHT = 200;
export const NUM_PIXELS = SCREEN_WIDTH * SCREEN_HEIGHT;
// RLE's worst case is 2 bytes per pixel, plus the PLAYPAL byte; a larger
// LENGTH can only be a corrupted field (serial_rx.py MAX_PAYLOAD_LEN).
export const MAX_PAYLOAD_LEN = 1 + 2 * NUM_PIXELS;

// CRC-16/CCITT-FALSE: poly 0x1021, init 0xFFFF, no reflection, no final XOR.
export function crc16(bytes, crc = 0xffff) {
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

// (count, value) pairs, runs capped at 255 (rle_run_length).
export function encodeRle(pixels) {
  const out = new Uint8Array(pixels.length * 2);
  let n = 0;
  for (let i = 0; i < pixels.length;) {
    const value = pixels[i];
    let run = 1;
    while (i + run < pixels.length && pixels[i + run] === value && run < 255) run++;
    out[n++] = run; out[n++] = value;
    i += run;
  }
  return out.subarray(0, n);
}

export function decodeRle(payload, expectedLength = NUM_PIXELS) {
  const out = new Uint8Array(expectedLength);
  let n = 0;
  for (let i = 0; i + 1 < payload.length && n < expectedLength; i += 2) {
    const count = Math.min(payload[i], expectedLength - n);
    out.fill(payload[i + 1], n, n + count);
    n += count;
  }
  return out.subarray(0, n);
}

// SYNC(2) | TYPE(1) | LENGTH(4 LE) | PLAYPAL(1) RLE(...) | CRC16(2 LE), the
// bytes N_frame_uart_send_frame() puts on the wire for one frame.
export function encodeFramePacket(pixels, playpalIndex) {
  const rle = encodeRle(pixels);
  const length = 1 + rle.length;
  const packet = new Uint8Array(2 + 1 + 4 + length + 2);
  packet[0] = FRAME_SYNC0; packet[1] = FRAME_SYNC1; packet[2] = FRAME_TYPE_DOOM_FRAME;
  new DataView(packet.buffer).setUint32(3, length, true);
  packet[7] = playpalIndex & 0xff;
  packet.set(rle, 8);
  const crc = crc16(packet.subarray(2, 8 + rle.length));
  packet[8 + rle.length] = crc & 0xff;
  packet[9 + rle.length] = crc >> 8;
  return packet;
}

// Incremental version of serial_rx.py read_packet(): feed bytes as they
// arrive; complete packets come back as { type, payload } and CRC failures
// or impossible lengths are counted and resynchronised on the next sync.
export class FrameParser {
  constructor() { this.reset(); this.stats = { packets: 0, crcErrors: 0, badLength: 0, bytes: 0 }; }
  reset() { this.state = 'sync'; this.prev = 0; this.header = []; this.payload = null; this.filled = 0; this.crcBytes = []; }
  push(bytes) {
    const done = [];
    for (const b of bytes) {
      this.stats.bytes++;
      if (this.state === 'sync') {
        if (this.prev === FRAME_SYNC0 && b === FRAME_SYNC1) { this.state = 'header'; this.header = []; }
        this.prev = b;
      } else if (this.state === 'header') {
        this.header.push(b);
        if (this.header.length === 5) {
          const length = (this.header[1] | (this.header[2] << 8) | (this.header[3] << 16) | (this.header[4] << 24)) >>> 0;
          if (length > MAX_PAYLOAD_LEN) { this.stats.badLength++; this.reset(); continue; }
          this.payload = new Uint8Array(length); this.filled = 0;
          this.state = length ? 'payload' : 'crc'; this.crcBytes = [];
        }
      } else if (this.state === 'payload') {
        this.payload[this.filled++] = b;
        if (this.filled === this.payload.length) { this.state = 'crc'; this.crcBytes = []; }
      } else {
        this.crcBytes.push(b);
        if (this.crcBytes.length === 2) {
          const received = this.crcBytes[0] | (this.crcBytes[1] << 8);
          const crc = crc16(this.payload, crc16(this.header));
          if (received === crc) { this.stats.packets++; done.push({ type: this.header[0], payload: this.payload }); }
          else this.stats.crcErrors++;
          this.reset();
        }
      }
    }
    return done;
  }
}

// A DOOM_FRAME payload as the ground station shows it, or null when short.
export function decodeFramePayload(payload) {
  if (!payload.length) return null;
  const pixels = decodeRle(payload.subarray(1), NUM_PIXELS);
  return pixels.length === NUM_PIXELS ? { playpal: payload[0], pixels } : null;
}

// assets/palettes.hex: 14 palettes x 256 lines of rrggbb.
export function parsePalettes(text) {
  const colours = text.split(/\s+/).filter((line) => /^[0-9a-f]{6}$/i.test(line)).map((hex) => parseInt(hex, 16));
  const palettes = [];
  for (let i = 0; i + 256 <= colours.length; i += 256) palettes.push(colours.slice(i, i + 256));
  return palettes;
}

// ---- Uplink: Spacecraft Command Format keyboard commands (messages.py)

export const CMD_DOOM_KEYBOARD = 0x02;
export const CMD_DOOM_EOF = 0x04;
export const MAX_KEYSTROKES_PER_PACKET = 60;
// Keys are sampled every 33 ms (30 Hz) by the ground station (app.py).
export const KEY_SAMPLE_MS = 33;

// HID usage IDs (USB HID Usage Tables 1.7, keyboard page) for the keys in
// hid.py QT_TO_HID, keyed by KeyboardEvent.code.
export const CODE_TO_HID = {
  Enter: 0x28, NumpadEnter: 0x28, Escape: 0x29, Backspace: 0x2a, Tab: 0x2b, Space: 0x2c,
  Minus: 0x2d, Equal: 0x2e, BracketLeft: 0x2f, BracketRight: 0x30, Backslash: 0x31, Semicolon: 0x33,
  Quote: 0x34, Backquote: 0x35, Comma: 0x36, Period: 0x37, Slash: 0x38, CapsLock: 0x39, Pause: 0x48,
  ArrowRight: 0x4f, ArrowLeft: 0x50, ArrowDown: 0x51, ArrowUp: 0x52,
};
for (let i = 0; i < 26; i++) CODE_TO_HID[`Key${String.fromCharCode(65 + i)}`] = 0x04 + i;
for (let i = 1; i <= 9; i++) CODE_TO_HID[`Digit${i}`] = 0x1d + i;
CODE_TO_HID.Digit0 = 0x27;
for (let i = 1; i <= 12; i++) CODE_TO_HID[`F${i}`] = 0x39 + i;

// hid.py QT_TO_HID_MODIFIERS: left Ctrl, Shift, Alt, GUI.
export const MODIFIER_BITS = { Control: 0x01, Shift: 0x02, Alt: 0x04, Meta: 0x08 };
export function modifierBit(code) {
  return MODIFIER_BITS[code.replace(/(Left|Right)$/, '').replace(/^OS$/, 'Meta')] || 0;
}

// DOOMKeystroke.from_qt_keys: modifiers OR-ed, the first three keys kept.
export function keystroke(heldCodes) {
  let modifiers = 0;
  const keys = [];
  for (const code of heldCodes) {
    const bit = modifierBit(code);
    if (bit) modifiers |= bit;
    else if (CODE_TO_HID[code]) keys.push(CODE_TO_HID[code]);
  }
  const [k1 = 0, k2 = 0, k3 = 0] = keys;
  return [modifiers, k1, k2, k3];
}
const isIdle = (k) => k.every((b) => b === 0);

// DOOMKeystrokeList.to_packets(): trailing idle samples are dropped, then
// one 0x02 packet per 60 keystrokes and a closing 0x04 EOF.
export function keyboardPackets(keystrokes, batch) {
  if (!(batch >= 0 && batch <= 255)) throw new RangeError(`Batch number must fit in one byte, got ${batch}.`);
  const list = keystrokes.slice();
  while (list.length && isIdle(list.at(-1))) list.pop();
  const chunks = [];
  for (let i = 0; i < list.length; i += MAX_KEYSTROKES_PER_PACKET) chunks.push(list.slice(i, i + MAX_KEYSTROKES_PER_PACKET));
  if (!chunks.length) chunks.push([]);
  if (chunks.length > 255) throw new RangeError('Recording needs more than 255 keyboard packets.');
  const packets = chunks.map((chunk, seq) => Uint8Array.from([CMD_DOOM_KEYBOARD, batch, seq, chunks.length, chunk.length, ...chunk.flat()]));
  packets.push(Uint8Array.from([CMD_DOOM_EOF, batch]));
  return packets;
}

// The balloon end: keyboard packets back into keystroke samples.
export function parseUplink(packet) {
  if (packet[0] === CMD_DOOM_EOF && packet.length === 2) return { command: 'eof', batch: packet[1] };
  if (packet[0] !== CMD_DOOM_KEYBOARD || packet.length < 5) return { command: 'unknown', id: packet[0] };
  const [, batch, seq, count, n] = packet;
  if (packet.length !== 5 + 4 * n) return { command: 'invalid', id: packet[0] };
  const keystrokes = [];
  for (let i = 0; i < n; i++) keystrokes.push(Array.from(packet.subarray(5 + 4 * i, 9 + 4 * i)));
  return { command: 'keyboard', batch, seq, count, keystrokes };
}

// HID usage -> doomgeneric key code (doomkeys.h), for the payload side. The
// repositories don't define this step yet (the OBC's payload commands are
// stubs), so it uses the IDE emulator's controls: WASD move, F fires.
const HID_TO_DOOM = { 0x28: 13, 0x29: 27, 0x2a: 0x7f, 0x2b: 9, 0x2c: 0xa2, 0x2d: 0x2d, 0x2e: 0x3d, 0x36: 0xa0, 0x37: 0xa1, 0x48: 0xff,
  0x4f: 0xae, 0x50: 0xac, 0x51: 0xaf, 0x52: 0xad };
for (let i = 0; i < 26; i++) HID_TO_DOOM[0x04 + i] = 0x61 + i;
Object.assign(HID_TO_DOOM, { 0x1a: 0xad, 0x16: 0xaf, 0x04: 0xac, 0x07: 0xae, 0x09: 0xa3 });
for (let i = 0; i < 9; i++) HID_TO_DOOM[0x1e + i] = 0x31 + i;
HID_TO_DOOM[0x27] = 0x30;
for (let i = 0; i < 10; i++) HID_TO_DOOM[0x3a + i] = 0x80 + 0x3b + i;
HID_TO_DOOM[0x44] = 0x80 + 0x57; HID_TO_DOOM[0x45] = 0x80 + 0x58;
const MODIFIER_TO_DOOM = [[0x01, 0xa3], [0x02, 0x80 + 0x36], [0x04, 0x80 + 0x38]]; // Ctrl fire, Shift run, Alt strafe

export function doomKeysFor([modifiers, ...keys]) {
  const held = new Set();
  for (const [bit, key] of MODIFIER_TO_DOOM) if (modifiers & bit) held.add(key);
  for (const hid of keys) if (hid && HID_TO_DOOM[hid] != null) held.add(HID_TO_DOOM[hid]);
  return held;
}
