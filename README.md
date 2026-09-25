# STM32 Forge — DOOM on STM32

A web IDE for STM32 microcontrollers that builds real firmware, shows real
memory usage per chip, flashes real hardware from the browser, and runs the
actual DOOM engine in its emulator panel.

## The task

1. **Real DOOM in the emulator.** The emulator panel must run id Software's
   DOOM (via the doomgeneric port), not a look-alike raycaster. The same engine
   sources are compiled to WebAssembly for the browser and to ARM for hardware.
2. **A real web IDE.** Editing, building and flashing must do real work:
   code is compiled with `arm-none-eabi-gcc`, and the reported flash/RAM
   figures come from the linker, not hard-coded numbers.
3. **Two targets.** The IDE supports both boards, and the selected target is
   made obvious by its memory budget in the RAM/flash usage display:

   | Target | Core | Flash | RAM |
   | --- | --- | --- | --- |
   | STM32F103C8T6 (Blue Pill) | Cortex-M3, 72 MHz | 64 KB | 20 KB |
   | STM32H743IITx | Cortex-M7, 480 MHz | 2 MB | 1 MB |

4. **Flashable on both devices.** Built binaries must be flashable to real
   hardware from the IDE:
   - Blue Pill: ROM UART bootloader (AN3155) over Web Serial, USART1 PA9/PA10, BOOT0 = 1.
   - H743: ROM USB DFU (DfuSe) over WebUSB on PA11/PA12, or the UART bootloader.

### Hardware constraints

- DOOM cannot run on the Blue Pill: the shareware WAD alone is 4 MB against
  64 KB of flash, and the engine needs far more than 20 KB of RAM. The linker's
  memory report is expected to show this overflow; the Blue Pill gets a smaller
  project that fits.
- On the H743 the WAD (4 MB) does not fit in 2 MB of internal flash, so it is
  read from a microSD card (SDMMC + FatFs). The zone heap lives in internal SRAM.

## Status

- [x] Vendor the DOOM engine (`engine/doomgeneric`) with guarded MCU hooks
      (`DG_NO_SCREENBUFFER`, `DG_ZONE_PROVIDER`)
- [x] WebAssembly build of the engine (`sim/build.sh` → `sim/doom.js`, `sim/doom.wasm`)
- [ ] Headless regression test for the WebAssembly build
- [ ] Wire the real engine into the IDE emulator panel (`index.html`)
- [ ] Local build server running `arm-none-eabi-gcc`, returning build log,
      binary and per-region memory usage
- [ ] Target selector in the IDE with RAM/flash usage bars against each chip's limits
- [ ] H743 firmware: clocks, SPI LCD, SD card + FatFs, input, DOOM platform layer
- [ ] Blue Pill firmware project that fits in 64 KB / 20 KB
- [ ] Browser flashing: AN3155 over Web Serial, DfuSe over WebUSB
- [ ] Regression tests for builds and flashing protocols (mock devices)

## Layout

```
index.html              Web IDE
engine/doomgeneric/     DOOM engine sources (GPLv2)
engine/platform/        Platform layers (dg_web.c for the browser)
sim/                    WebAssembly build script, output and DOOM1.WAD (shareware)
```

## Building the simulator

Requires emscripten:

```sh
sim/build.sh
```

## Licensing

The DOOM engine is GPLv2 (see `engine/doomgeneric/LICENSE`). `sim/doom1.wad`
is the unmodified DOOM shareware v1.9 IWAD, which may be freely redistributed.
