// The 915 MHz video link of uvsd-doom-gnu-radio, sample for sample:
//   transmit  DOOMflow.grc epy_block_2 "Raw 4-GFSK Mod": 2 bits per symbol, MSB
//             first, 00 01 10 11 -> -1 -1/3 +1/3 +1 times the deviation,
//             rectangular pulses, continuous phase
//   frames    gen_doom_gameplay.py (160x100, 4 bpp grey) and
//             gen_raw_game_data_rgb.py (320x200, R G B planes, 2 bits each):
//             AA BB CC DD + pixels packed MSB first, Bayer dithered, scrubbed
//             so the pixels never look like a sync word
//   receive   the enabled DOOMflow chain (quadrature demod with gain
//             samp_rate/(2*pi*deviation), filtering, symbol sync) and
//             view_doom_zmq.py (auto-levelled 4-level slicer, header search in
//             both polarities with one symbol error tolerated), with the level
//             fit of uvsd-doom-gnu-radio PR #1

export const PHY_DEFAULTS = { sampleRate: 2.5e6, symbolRate: 625e3, deviation: 125e3, centerFreq: 915e6 };
export const FSK_LEVELS = [-1, -1 / 3, 1 / 3, 1];
export const SYNC_WORDS = { AABBCCDD: [0xaa, 0xbb, 0xcc, 0xdd], DEADBEEF: [0xde, 0xad, 0xbe, 0xef] };
const BAYER = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]].map((row) => row.map((v) => (v + 0.5) / 16));

export const FRAME_FORMATS = {
  grey: { label: '160×100 grey, 4 bpp (gen_doom_gameplay.py)', width: 160, height: 100, planes: 1, bits: 4 },
  colour: { label: '320×200 colour, 2 bits per channel (gen_raw_game_data_rgb.py)', width: 320, height: 200, planes: 3, bits: 2 },
};
export const frameBytes = (f) => (f.planes * f.width * f.height * f.bits) / 8;

export function bytesToSymbols(bytes) {
  const out = new Uint8Array(bytes.length * 4);
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    out[4 * i] = b >> 6; out[4 * i + 1] = (b >> 4) & 3; out[4 * i + 2] = (b >> 2) & 3; out[4 * i + 3] = b & 3;
  }
  return out;
}
export function symbolsToBytes(sym) {
  const out = new Uint8Array(sym.length >> 2);
  for (let i = 0; i < out.length; i++) out[i] = (sym[4 * i] << 6) | (sym[4 * i + 1] << 4) | (sym[4 * i + 2] << 2) | sym[4 * i + 3];
  return out;
}

// Header patterns the receiver looks for: both sync words, both polarities.
export const HEADER_PATTERNS = Object.entries(SYNC_WORDS).flatMap(([name, bytes]) => {
  const p = bytesToSymbols(Uint8Array.from(bytes));
  return [{ name, symbols: p, inverted: false }, { name, symbols: p.map((s) => 3 - s), inverted: true }];
});
const HDR_LEN = 16;

// gen_raw_game_data_rgb.py scrub(): flip single symbols wherever the pixel
// data comes within two symbol errors of a header.
export function scrub(payload) {
  const sym = bytesToSymbols(payload);
  let fixes = 0;
  for (let pass = 0; pass < 50; pass++) {
    let found = false, lastEnd = -1;
    for (let i = 0; i + HDR_LEN <= sym.length; i++) {
      if (i < lastEnd) continue;
      for (const { symbols: pat } of HEADER_PATTERNS) {
        let mism = 0;
        for (let j = 0; j < HDR_LEN && mism <= 2; j++) if (sym[i + j] !== pat[j]) mism++;
        if (mism > 2) continue;
        let flips = 3 - mism;
        for (let j = 0; j < HDR_LEN && flips > 0; j++) if (sym[i + j] === pat[j]) { sym[i + j] ^= 1; flips--; }
        found = true; fixes++; lastEnd = i + HDR_LEN;
        break;
      }
    }
    if (!found) break;
  }
  return { bytes: symbolsToBytes(sym), fixes };
}

function packSamples(values, bits) {
  const out = new Uint8Array((values.length * bits) / 8);
  let acc = 0, n = 0, o = 0;
  for (const v of values) {
    acc = (acc << bits) | v; n += bits;
    if (n >= 8) { n -= 8; out[o++] = (acc >> n) & 0xff; }
  }
  return out;
}

// One link frame from a 320x200 RGBA picture: sync word + packed pixels.
export function encodeTestFrame(rgba, format) {
  const { width, height, planes, bits } = format;
  const levels = (1 << bits) - 1;
  const step = 320 / width;
  const plane = (c) => {
    const q = new Uint8Array(width * height);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let dy = 0; dy < step; dy++) for (let dx = 0; dx < step; dx++) {
        const p = ((y * step + dy) * 320 + x * step + dx) * 4;
        sum += c < 0 ? (0.299 * rgba[p] + 0.587 * rgba[p + 1] + 0.114 * rgba[p + 2]) : rgba[p + c];
      }
      const v = sum / (step * step) / 255;
      q[y * width + x] = Math.max(0, Math.min(levels, Math.floor(v * levels + BAYER[y & 3][x & 3])));
    }
    return packSamples(q, bits);
  };
  const parts = planes === 1 ? [plane(-1)] : [plane(0), plane(1), plane(2)];
  const pixels = new Uint8Array(frameBytes(format));
  let o = 0;
  for (const part of parts) { pixels.set(part, o); o += part.length; }
  const { bytes, fixes } = scrub(pixels);
  const frame = new Uint8Array(4 + bytes.length);
  frame.set(SYNC_WORDS.AABBCCDD); frame.set(bytes, 4);
  return { frame, fixes };
}

// A received frame's symbols back into a 320x200 RGBA picture.
export function decodeTestFrame(symbols, format, out = new Uint8ClampedArray(320 * 200 * 4)) {
  const { width, height, planes, bits } = format;
  const bytes = symbolsToBytes(symbols);
  const per = width * height, scale = 255 / ((1 << bits) - 1), step = 320 / width;
  const sample = (index) => {
    const bit = index * bits;
    return (bytes[bit >> 3] >> (8 - bits - (bit & 7))) & ((1 << bits) - 1);
  };
  for (let y = 0; y < 200; y++) for (let x = 0; x < 320; x++) {
    const i = Math.floor(y / step) * width + Math.floor(x / step), p = (y * 320 + x) * 4;
    if (planes === 1) out[p] = out[p + 1] = out[p + 2] = sample(i) * scale;
    else for (let c = 0; c < 3; c++) out[p + c] = sample(c * per + i) * scale;
    out[p + 3] = 255;
  }
  return out;
}

// ---- PHY

export class FskModulator {
  constructor(phy = PHY_DEFAULTS) { this.phy = phy; this.sps = Math.round(phy.sampleRate / phy.symbolRate); this.phase = 0; }
  // Interleaved I/Q (Float32Array) for 2-bit symbols.
  modulate(symbols) {
    const { sps } = this, iq = new Float32Array(symbols.length * sps * 2);
    const k = (2 * Math.PI * this.phy.deviation) / this.phy.sampleRate;
    let phase = this.phase, n = 0;
    for (const s of symbols) {
      const dphi = FSK_LEVELS[s] * k;
      for (let j = 0; j < sps; j++) { phase += dphi; iq[n++] = Math.cos(phase); iq[n++] = Math.sin(phase); }
    }
    this.phase = phase % (2 * Math.PI);
    return iq;
  }
}

// Additive white Gaussian noise at an SNR measured over the full sample
// bandwidth, and a carrier frequency offset (an RTL-SDR is typically tens of
// ppm off: 20 ppm at 915 MHz is 18 kHz).
export class Channel {
  constructor(phy = PHY_DEFAULTS) { this.phy = phy; this.snrDb = 20; this.offsetHz = 0; this.rot = 0; this.spare = null; }
  gauss() {
    if (this.spare != null) { const s = this.spare; this.spare = null; return s; }
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    v = Math.random();
    const r = Math.sqrt(-2 * Math.log(u));
    this.spare = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  }
  apply(iq) {
    const sigma = Math.sqrt(10 ** (-this.snrDb / 10) / 2);
    const w = (2 * Math.PI * this.offsetHz) / this.phy.sampleRate;
    const out = new Float32Array(iq.length);
    let rot = this.rot;
    for (let n = 0; n < iq.length; n += 2) {
      const c = Math.cos(rot), s = Math.sin(rot);
      out[n] = iq[n] * c - iq[n + 1] * s + sigma * this.gauss();
      out[n + 1] = iq[n] * s + iq[n + 1] * c + sigma * this.gauss();
      rot += w;
    }
    this.rot = rot % (2 * Math.PI);
    return out;
  }
}

// Quadrature demodulator scaled so the four tones come out at -1 -1/3 +1/3
// +1, followed by an average over each symbol (the matched filter for
// rectangular pulses). The simulation's symbol clock is exact; on air the
// flowgraph's Symbol Sync block recovers it.
export class FskDemodulator {
  constructor(phy = PHY_DEFAULTS) {
    this.phy = phy; this.sps = Math.round(phy.sampleRate / phy.symbolRate);
    this.gain = phy.sampleRate / (2 * Math.PI * phy.deviation);
    this.prevI = 1; this.prevQ = 0;
  }
  demodulate(iq) {
    const { sps, gain } = this, out = new Float32Array(iq.length / 2 / sps);
    let pi = this.prevI, pq = this.prevQ, n = 0;
    for (let k = 0; k < out.length; k++) {
      let acc = 0;
      for (let j = 0; j < sps; j++, n += 2) {
        const i = iq[n], q = iq[n + 1];
        acc += Math.atan2(q * pi - i * pq, i * pi + q * pq);
        pi = i; pq = q;
      }
      out[k] = (acc / sps) * gain;
    }
    this.prevI = pi; this.prevQ = pq;
    return out;
  }
}

// view_doom_zmq.py: every 0.25 s of link time the slicer levels are
// re-estimated from the last 60,000 symbols, by fitting c and a in
// c + a*(-1, -1/3, 1/3, 1) (uvsd-doom-gnu-radio PR #1: spreading them between
// percentiles lost sync on colour frames, which hardly use the upper tones),
// smoothed 70/30; then a header search with one symbol error allowed, where
// an inverted header flips the polarity.
export class TestFrameReceiver {
  constructor(format, symbolRate = PHY_DEFAULTS.symbolRate) {
    this.format = format;
    this.frameSyms = frameBytes(format) * 4;
    this.thr = [-0.66, 0, 0.66];
    this.recent = new Float32Array(0);
    this.updateEvery = 0.25 * symbolRate; this.sinceUpdate = 0;
    this.levels = []; this.inFrame = false; this.invert = false;
    this.stats = { frames: 0, headers: 0, cleanHeaders: 0, symbols: 0, histogram: [0, 0, 0, 0], lastHeader: '-' };
  }
  updateThresholds() {
    const recent = this.recent;
    if (recent.length < 5000) return;
    const sorted = Float32Array.from(recent).sort();
    if (sorted[Math.floor(0.98 * (sorted.length - 1))] - sorted[Math.floor(0.02 * (sorted.length - 1))] < 0.05) return;
    let c = this.thr[1], a = (this.thr[2] - this.thr[0]) * 0.75;
    for (let iteration = 0; iteration < 4; iteration++) {
      let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
      const used = new Set();
      for (const v of recent) {
        const level = Math.min(3, Math.max(0, Math.round(((v - c) / a + 1) * 1.5)));
        const x = FSK_LEVELS[level];
        used.add(level); n++; sx += x; sy += v; sxx += x * x; sxy += x * v;
      }
      if (used.size < 2) return;
      a = (n * sxy - sx * sy) / (n * sxx - sx * sx);
      c = (sy - a * sx) / n;
      if (!(a >= 0.05)) return;
    }
    this.thr = this.thr.map((t, i) => 0.7 * t + 0.3 * (c + a * [-2 / 3, 0, 2 / 3][i]));
  }
  // Feeds demodulated symbol values; returns completed frames' symbols.
  push(values) {
    const merged = new Float32Array(this.recent.length + values.length);
    merged.set(this.recent); merged.set(values, this.recent.length);
    this.recent = merged.length > 60000 ? merged.slice(merged.length - 60000) : merged;
    this.sinceUpdate += values.length;
    if (this.sinceUpdate >= this.updateEvery) { this.updateThresholds(); this.sinceUpdate = 0; }
    const [t1, t2, t3] = this.thr;
    for (const v of values) {
      let l = v < t1 ? 0 : v < t2 ? 1 : v < t3 ? 2 : 3;
      this.stats.histogram[l]++;
      if (this.invert) l = 3 - l;
      this.levels.push(l);
    }
    this.stats.symbols += values.length;
    const frames = [];
    for (;;) {
      if (!this.inFrame) {
        const hit = this.findHeader();
        if (!hit) { if (this.levels.length > HDR_LEN - 1) this.levels.splice(0, this.levels.length - (HDR_LEN - 1)); break; }
        this.stats.headers++;
        if (hit.index === 0) this.stats.cleanHeaders++;
        this.stats.lastHeader = `${hit.name}${hit.inverted ? ' (inverted)' : ''}`;
        this.levels.splice(0, hit.index + HDR_LEN);
        if (hit.inverted) { this.invert = !this.invert; this.levels = this.levels.map((l) => 3 - l); }
        this.inFrame = true;
      } else {
        if (this.levels.length < this.frameSyms) break;
        frames.push(Uint8Array.from(this.levels.splice(0, this.frameSyms)));
        this.stats.frames++;
        this.inFrame = false;
      }
    }
    return frames;
  }
  findHeader() {
    const lv = this.levels;
    for (let i = 0; i + HDR_LEN <= lv.length; i++) {
      for (const p of HEADER_PATTERNS) {
        let mism = 0;
        for (let j = 0; j < HDR_LEN && mism <= 1; j++) if (lv[i + j] !== p.symbols[j]) mism++;
        if (mism <= 1) return { index: i, ...p };
      }
    }
    return null;
  }
}

// Power spectrum (dB) of the first n complex samples, centred on DC.
export function spectrum(iq, n = 512) {
  const re = new Float64Array(n), im = new Float64Array(n);
  for (let i = 0; i < n && 2 * i + 1 < iq.length; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    re[i] = iq[2 * i] * w; im[i] = iq[2 * i + 1] * w;
  }
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    for (let i = 0; i < n; i += len) for (let j = 0; j < len / 2; j++) {
      const wr = Math.cos(ang * j), wi = Math.sin(ang * j);
      const ur = re[i + j], ui = im[i + j];
      const vr = re[i + j + len / 2] * wr - im[i + j + len / 2] * wi, vi = re[i + j + len / 2] * wi + im[i + j + len / 2] * wr;
      re[i + j] = ur + vr; im[i + j] = ui + vi; re[i + j + len / 2] = ur - vr; im[i + j + len / 2] = ui - vi;
    }
  }
  const db = new Float32Array(n);
  for (let i = 0; i < n; i++) { const k = (i + n / 2) % n; db[i] = 10 * Math.log10((re[k] ** 2 + im[k] ** 2) / n + 1e-12); }
  return db;
}
