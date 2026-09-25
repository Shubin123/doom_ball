// Runs the DOOM engine compiled to WebAssembly (sim/doom.js) on a canvas.
// The zone heap is split into the same banks, with the same sizes, as the
// firmware build for the selected target, so the simulator runs under the
// real memory budget.

export const DOOM_KEYS = {
  ArrowRight: 0xae, ArrowLeft: 0xac, ArrowUp: 0xad, ArrowDown: 0xaf,
  Control: 0xa3, ' ': 0xa2, Escape: 27, Enter: 13, Tab: 9, Backspace: 0x7f,
  Shift: 0x80 + 0x36, Alt: 0x80 + 0x38, ',': 0xa0, '.': 0xa1, '-': 0x2d, '=': 0x3d,
  F1: 0x80 + 0x3b, F2: 0x80 + 0x3c, F3: 0x80 + 0x3d, F4: 0x80 + 0x3e, F5: 0x80 + 0x3f,
  F6: 0x80 + 0x40, F7: 0x80 + 0x41, F8: 0x80 + 0x42, F9: 0x80 + 0x43, F10: 0x80 + 0x44,
  F11: 0x80 + 0x57, Pause: 0xff,
};

export function doomKey(e) {
  if (e.key in DOOM_KEYS) return DOOM_KEYS[e.key];
  if (e.key.length === 1) {
    const c = e.key.toLowerCase().charCodeAt(0);
    if (c >= 32 && c < 127) return c;
  }
  return null;
}

// Loads a classic script; unlike fetch() this also works from file://.
export function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`could not load ${src}`));
    document.head.appendChild(s);
  });
}

export function fromBase64(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

let wadPromise = null;
function loadWad() {
  wadPromise = wadPromise || fetch('sim/doom1.wad')
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.arrayBuffer();
    })
    .catch(async () => {
      await loadScript('sim/doom1.wad.js');
      return fromBase64(window.FORGE_WAD_B64).buffer;
    });
  return wadPromise;
}

export class DoomSim {
  constructor(canvas, { onStatus = () => {}, onExit = () => {} } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.image = this.ctx.createImageData(320, 200);
    this.onStatus = onStatus;
    this.onExit = onExit;
    this.mod = null;
    this.running = false;
    this.frames = 0;
  }

  // banks: zone bank sizes in bytes (from the firmware link), in order.
  async start(banks) {
    this.stop();
    if (typeof createDoomModule !== 'function') throw new Error('sim/doom.js did not load');
    const wad = await loadWad();
    let log = '';
    let lastErr = '';
    const mod = await createDoomModule({
      noMainLoop: true,
      print: (t) => { log += t + '\n'; },
      printErr: (t) => {
        log += t + '\n';
        if (t.trim()) lastErr = t.trim();       // I_Error() writes its message to stderr
      },
      onFrame: (ptr) => {
        this.image.data.set(mod.HEAPU8.subarray(ptr, ptr + 320 * 200 * 4));
        this.ctx.putImageData(this.image, 0, 0);
        this.frames++;
      },
    });
    mod.FS.writeFile('/DOOM1.WAD', new Uint8Array(wad));

    const GAP = 16 * 1024;
    let off = 0;
    banks.forEach((size, i) => {
      off += size;
      if (i < banks.length - 1) {
        mod._dg_add_zone_gap(off, GAP);
        off += GAP;
      }
    });
    mod._dg_set_zone_size(off);

    this.mod = mod;
    this.log = () => log;
    this.lastErr = () => lastErr;
    try {
      mod.callMain(['-iwad', '/DOOM1.WAD']);
    } catch (e) {
      this.fail(e);
      return;
    }
    this.running = true;
    this.loop();
  }

  loop() {
    const TIC_MS = 1000 / 35;
    let last = performance.now();
    let fpsFrames = 0;
    let fpsTime = last;
    const step = (now) => {
      if (!this.running) return;
      if (now - last >= TIC_MS - 1) {
        last = now;
        try {
          this.mod._doomgeneric_Tick();
        } catch (e) {
          this.fail(e);
          return;
        }
        fpsFrames++;
      }
      if (now - fpsTime > 1000) {
        this.onStatus(`${Math.round((fpsFrames * 1000) / (now - fpsTime))} fps`);
        fpsFrames = 0;
        fpsTime = now;
      }
      this.raf = requestAnimationFrame(step);
    };
    this.raf = requestAnimationFrame(step);
  }

  fail(e) {
    this.running = false;
    const text = this.log ? this.log() : '';
    const reason = (this.lastErr && this.lastErr()) || String(e && e.message ? e.message : e);
    this.onExit(reason, text);
  }

  key(pressed, code) {
    if (this.running && code != null) this.mod._dg_push_key(pressed ? 1 : 0, code);
  }

  stop() {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.mod = null;
  }
}
