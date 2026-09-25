// Runs the DOOM wasm build headless under Node: loads DOOM1.WAD, lets the
// title/demo loop run for N tics and checks that frames were rendered.
// Usage: node tests/sim_headless.mjs [zoneKB] [tics] [--h743]
//   --h743 uses the zone banks of the H743 firmware build (read from
//   firmware/build/h743-doom/firmware.elf when present), separated by
//   unmapped gaps exactly as on the chip; zoneKB is ignored.
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const createDoomModule = require(path.join(root, 'sim/doom.js'));

// banks: array of bank sizes in bytes; a 16 KB gap is inserted between banks.
export async function runDoom({ zoneKB = 6144, tics = 700, banks = null } = {}) {
  let frames = 0, lastFrame = null, out = '', aborted = null, mod;
  mod = await createDoomModule({
    noMainLoop: true,
    print: (t) => { out += t + '\n'; },
    printErr: (t) => { out += t + '\n'; },
    onAbort: (e) => { aborted = String(e); },
    onFrame(ptr, w, h) {
      frames++;
      lastFrame = mod.HEAPU32.slice(ptr >> 2, (ptr >> 2) + w * h);
    },
  });
  mod.FS.writeFile('/doom1.wad', readFileSync(path.join(root, 'sim/doom1.wad')));
  if (banks) {
    const GAP = 16 * 1024;
    let off = 0;
    banks.forEach((b, i) => {
      off += b;
      if (i < banks.length - 1) { mod._dg_add_zone_gap(off, GAP); off += GAP; }
    });
    mod._dg_set_zone_size(off);
  } else {
    mod._dg_set_zone_size(zoneKB * 1024);
  }
  try {
    mod.callMain(['-iwad', '/doom1.wad']);
    for (let i = 0; i < tics && !aborted; i++) {
      mod._doomgeneric_Tick();
      if (i % 50 === 0) mod._dg_check_heap();
    }
  } catch (e) {
    aborted = aborted || String(e);
  }
  if (!aborted && /Error:/.test(out)) aborted = out.match(/.*Error:.*/)[0];
  const colours = lastFrame ? new Set(lastFrame).size : 0;
  return { frames, colours, aborted, out };
}

// Zone bank sizes of the H743 build: from the ELF symbols if it has been
// built, otherwise the values of the reference build.
export function h743ZoneBanks() {
  const elf = path.join(root, 'firmware/build/h743-doom/firmware.elf');
  const nm = [process.env.ARM_GCC_PATH && path.join(process.env.ARM_GCC_PATH, 'arm-none-eabi-nm'), 'arm-none-eabi-nm'].filter(Boolean);
  if (existsSync(elf)) {
    for (const tool of nm) {
      try {
        const sym = {};
        for (const line of execFileSync(tool, [elf], { encoding: 'utf8' }).split('\n')) {
          const m = line.match(/^([0-9a-f]+) \w (__zone\d_(start|end))$/);
          if (m) sym[m[2]] = parseInt(m[1], 16);
        }
        if (sym.__zone2_end) return [0, 1, 2].map(i => sym[`__zone${i}_end`] - sym[`__zone${i}_start`]);
      } catch { /* try next */ }
    }
  }
  return [12336, 416672, 294912];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const h743 = process.argv.includes('--h743');
  const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
  const tics = Number(args[1] || 700);
  let opts = { zoneKB: Number(args[0] || 6144), tics };
  if (h743) {
    opts = { tics, banks: h743ZoneBanks() };
    opts.zoneKB = Math.floor(opts.banks.reduce((a, b) => a + b, 0) / 1024);
  }
  const r = await runDoom(opts);
  console.log(JSON.stringify({ zoneKB: opts.zoneKB, banks: opts.banks, frames: r.frames, colours: r.colours, aborted: r.aborted }));
  if (r.aborted) console.log(r.out.split('\n').slice(-8).join('\n'));
  process.exit(r.aborted || r.frames < 10 || r.colours < 16 ? 1 : 0);
}
