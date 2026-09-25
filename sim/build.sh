#!/bin/sh
# Builds the browser simulator (real DOOM engine -> WebAssembly).
# Output: sim/doom.js + sim/doom.wasm. Requires emscripten (emcc).
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
ENG="$ROOT/engine/doomgeneric"
SRC=$(ls "$ENG"/*.c)
emcc -O2 -std=gnu99 -w \
  -DCMAP256 -DDG_NO_SCREENBUFFER -DDG_ZONE_PROVIDER \
  -DDOOMGENERIC_RESX=320 -DDOOMGENERIC_RESY=200 \
  -I"$ENG" $SRC "$ROOT/engine/platform/dg_web.c" \
  -sMODULARIZE=1 -sEXPORT_NAME=createDoomModule \
  -sALLOW_MEMORY_GROWTH=1 -sFORCE_FILESYSTEM=1 -sINVOKE_RUN=0 -sEXIT_RUNTIME=0 \
  -sENVIRONMENT=web,node \
  -sEXPORTED_FUNCTIONS=_main,_dg_push_key,_dg_set_zone_size,_dg_frame_ptr \
  -sEXPORTED_RUNTIME_METHODS=FS,callMain,HEAPU8,HEAPU32 \
  -o "$ROOT/sim/doom.js"
ls -l "$ROOT/sim/doom.js" "$ROOT/sim/doom.wasm"
