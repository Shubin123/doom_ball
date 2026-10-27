# NOTE: CURRENTLY WORKING ON SPI CONNECTION BETWEEN NRFBOARD BUT USB CONNECTION WORKS

# UVic Satellite Design Pico Bridge

This repository contains a Raspberry Pi Pico firmware project and a laptop-side
USB serial receiver for transferring a JPEG image from the Pico to a computer.
The current firmware sends the image embedded in `spi_connection/photo.h`;
the intended SPI input path is not active yet.

## Note about photo.h

Currently the pico only transfers a hardcoded photo.h build from 
```bash
xxd -i photo.jpg > photo.h
```
Later this will be replaced by the actually SPI chunk frames from the nRF board when initialized.

`photo.h` is not committed. When it is missing, the CMake build generates the
same array from `spi_connection/sample_frame.jpg` (a DOOM E1M1 frame), so a
fresh clone builds. Pass `-DPHOTO_JPG=/path/to/image.jpg` to CMake to embed a
different image.

## Repository layout

- `spi_connection/` — Pico firmware, embedded image, and CMake build files.
- `usb_laptop/` — Python USB serial receiver built on PySerial.

## Firmware build and flash

Requirements:

- Raspberry Pi Pico SDK 2.3.0 or later.
- CMake and a toolchain supported by the Pico SDK.

From `spi_connection/`, with `PICO_SDK_PATH` pointing at your SDK checkout,
configure and build (targets RP2350 / Pico 2):

```sh
./build.sh
```

Copy `spi_connection/build/spi_connection.uf2` using `./flash.sh` to the Pico while it is in
BOOTSEL mode to flash the firmware. 

## Laptop receiver

The receiver uses Python 3.14 or later and PySerial. From `usb_laptop/`, install
the project dependencies with:

```sh
uv sync
```

Run it with the Pico's serial port and, optionally, an output file:

```sh
uv run usb /dev/ttyACM0                        # Linux (the default port)
uv run usb /dev/cu.usbmodem1101 frame.jpg      # macOS
```

The image is written to `frame_output.jpg` unless another file is given.
Open the port before the Pico finishes its 2 s boot delay: USB stdio drops
output while no host has the port open.

## Current transfer behavior

After boot, the Pico waits briefly, writes a text header over USB serial, sends
the image bytes in 3,072-byte chunks, then writes the `\n__IMAGE_EOF__\n`
terminator. The laptop receiver reads the stream, removes the terminator, looks
for the JPEG start marker, and writes the resulting bytes to the configured
file. USB serial ignores the 115200 baud setting; UART stdio is disabled so
the transfer runs at USB speed.

`uv run pytest` (from `usb_laptop/`) replays that byte stream over a
pseudo-terminal and checks that the sample frame arrives byte for byte.

The firmware's SPI pin and peripheral setup is present only as commented-out
code; the image is currently sent from the embedded `photo.h` data instead.