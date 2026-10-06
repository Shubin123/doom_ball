#!/bin/sh
# Regression suite. Needs arm-none-eabi-gcc (PATH or ARM_GCC_PATH), node,
# emcc (only to rebuild the sim), and for the firmware emulator test the
# Python packages in tests/emu/requirements.txt (PYTHON=/path/to/python).
set -u
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
PYTHON=${PYTHON:-python3}
fail=0
step() { printf '\n=== %s\n' "$*"; }
check() { if [ "$1" -eq 0 ]; then echo "PASS: $2"; else echo "FAIL: $2"; fail=1; fi; }

if [ -z "${ARM_GCC_PATH:-}" ] && ! command -v arm-none-eabi-gcc >/dev/null; then
  ARM_GCC_PATH=$(ls -d "$HOME"/.local/toolchains/*/bin 2>/dev/null | tail -1)
fi
MAKEARGS="-C firmware -j$(nproc 2>/dev/null || echo 4) ${ARM_GCC_PATH:+ARM_GCC_PATH=$ARM_GCC_PATH}"

step "firmware builds"
for tp in h743:doom h743:blinky bluepill:blinky f401:blinky; do
  make $MAKEARGS TARGET=${tp%%:*} PROJECT=${tp##*:} >/tmp/forge_build.log 2>&1
  check $? "build ${tp%%:*}/${tp##*:}"
done
make $MAKEARGS TARGET=bluepill PROJECT=doom >/tmp/forge_build.log 2>&1
if [ $? -ne 0 ] && grep -q "region \`RAM' overflowed" /tmp/forge_build.log \
   && grep -q "region \`FLASH' overflowed" /tmp/forge_build.log; then r=0; else r=1; fi
check $r "bluepill/doom is rejected by the linker (flash + RAM overflow)"

step "flashing: protocols against simulated probes and bootloaders, IDE end to end in headless Chrome"
FORGE_HW= node --test tests/ >/tmp/forge_flash.log 2>&1   # hardware gets its own step below
check $? "node --test tests/"
grep -E "^(✔|✖|﹣)" /tmp/forge_flash.log

step "flashing real hardware through an ST-Link"
if [ "${FORGE_HW:-}" = 1 ]; then
  node --test tests/hw_flash.test.mjs
  check $? "stlink.js and the IDE flash the connected board"
else
  echo "SKIP: set FORGE_HW=1 with an ST-Link and board connected (needs: npm i --no-save usb)"
fi

step "DOOM wasm build, headless"
node tests/sim_headless.mjs 6144 700
check $? "sim: title + demo with a 6 MB zone"
node tests/sim_headless.mjs 0 3000 --h743
check $? "sim: 3000 tics with the H743 zone banks"

step "IDE opened from disk (file://)"
cp ide/forge.js /tmp/forge_bundle_before.js
node tools/bundle_ide.mjs >/dev/null
cmp -s ide/forge.js /tmp/forge_bundle_before.js
check $? "ide/forge.js is up to date with the ide/ modules"
# First browser that actually starts (a stale wrapper can outlive its app).
if [ -z "${CHROME:-}" ]; then
  for c in google-chrome-stable google-chrome chromium "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"; do
    c=$(command -v "$c" || true)
    if [ -n "$c" ] && "$c" --version >/dev/null 2>&1; then CHROME=$c; break; fi
  done
fi
CHROME=${CHROME:-}
if [ -n "$CHROME" ]; then
  node tests/file_url.mjs "$CHROME"
  check $? "index.html from file:// runs DOOM in headless Chrome"
else
  echo "SKIP: no Chrome/Chromium found (set CHROME)"
fi

step "H743 firmware in the Cortex-M7 emulator"
if $PYTHON -c "import unicorn, elftools, PIL" 2>/dev/null; then
  $PYTHON tests/emu/h743_emu.py --frames 120 --timeout 900 \
    --keys "10:enter,16:enter,22:enter,28:enter,50-110:up,90:fire" >/tmp/forge_emu.log 2>&1
  r=$?
  tail -1 /tmp/forge_emu.log
  check $r "firmware.elf boots, loads DOOM1.WAD from SD and plays E1M1"
else
  echo "SKIP: install tests/emu/requirements.txt (or set PYTHON) to run"
fi

step "result"
[ $fail -eq 0 ] && echo "ALL PASSED" || echo "SOME TESTS FAILED"
exit $fail
