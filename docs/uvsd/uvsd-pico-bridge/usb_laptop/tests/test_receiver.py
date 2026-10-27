"""Receive an image over a pseudo-terminal that sends exactly what the Pico
firmware (spi_connection.c) writes to USB serial, and check it arrives intact."""

import os
import pty
import threading
import time
import tty
from pathlib import Path

import pytest

from usb_laptop.main import END_OF_FILE_MARKER, USBConnection

SAMPLE = Path(__file__).resolve().parents[2] / "spi_connection" / "sample_frame.jpg"
CHUNK_SIZE = 3072  # read_image_frame() in spi_connection.c


def pico_stream(fd: int, image: bytes) -> None:
    time.sleep(0.2)  # the firmware waits 2 s after boot
    os.write(fd, f"Received image frame of length: {len(image)}\n".encode())
    time.sleep(0.05)
    for start in range(0, len(image), CHUNK_SIZE):
        os.write(fd, image[start : start + CHUNK_SIZE])
        time.sleep(0.002)
    os.write(fd, END_OF_FILE_MARKER)


@pytest.mark.skipif(not hasattr(pty, "openpty"), reason="needs a POSIX pseudo-terminal")
def test_receives_image_byte_for_byte(tmp_path: Path) -> None:
    image = SAMPLE.read_bytes()
    pico, laptop = pty.openpty()
    tty.setraw(pico)
    tty.setraw(laptop)
    sender = threading.Thread(target=pico_stream, args=(pico, image), daemon=True)
    sender.start()

    out = tmp_path / "frame_output.jpg"
    connection = USBConnection(
        port=os.ttyname(laptop), baudrate=115200, destination_file=str(out), payload=bytearray()
    )
    connection.open_connection()
    connection.read_frame_data()
    connection.write_frame_data()
    connection.clean_up()
    sender.join(5)
    os.close(pico)
    os.close(laptop)

    assert out.read_bytes() == image
