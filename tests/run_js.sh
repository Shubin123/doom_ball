#!/bin/sh
# JavaScript-only regression suite: IDE source search, flashing protocols, and
# DOOM's WebAssembly gameplay path. No Python toolchain or workflow is needed.
set -eu
cd "$(dirname "$0")/.."
node --test tests/*.test.mjs
node tests/sim_headless.mjs 6144 700
