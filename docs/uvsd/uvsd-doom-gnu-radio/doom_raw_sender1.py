"""
Streams raw frames (sync word + packed pixels) to the raw 4-GFSK modulator block.

    python doom_raw_sender.py --file doom_raw.bin                # loop a file made by gen_raw_game_data.py
    python doom_raw_sender.py                                    # built-in scene, no file needed
    python doom_raw_sender.py --port socket://127.0.0.1:5558     # explicit TCP target (the default)
    python doom_raw_sender.py --port COM10 --baud 2000000        # a real/virtual serial port

TCP (the default) needs nothing beyond the standard library. pyserial is only imported when you
use a serial port: pip install pyserial (and pip uninstall serial if you ever installed that one).

Each frame on the wire = AA BB CC DD + W*H*BPP/8 pixel bytes (sizes from gen_doom_gameplay.py).
"""
import argparse
import socket
import sys
import time

import gen_doom_gameplay as g


class _TcpLink:
    def __init__(self, host, port):
        self.s = socket.create_connection((host, port), timeout=5)
        self.s.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        self.s.settimeout(None)

    def write(self, data):
        self.s.sendall(data)

    def close(self):
        self.s.close()


def open_link(port, baud):
    p = port.strip()
    for prefix in ("socket://", "tcp://", "tcp:"):
        if p.lower().startswith(prefix):
            hp = p[len(prefix):]
            host, _, prt = hp.rpartition(":")
            return _TcpLink(host or "127.0.0.1", int(prt or hp))
    if p.isdigit():
        return _TcpLink("127.0.0.1", int(p))
    try:
        import serial
    except ImportError:
        raise SystemExit("pyserial is not installed: pip install pyserial")
    if not hasattr(serial, "Serial"):
        raise SystemExit("The installed 'serial' package is not pyserial. Run:\n"
                         "  pip uninstall serial\n  pip install pyserial")
    return serial.Serial(p, baud, timeout=1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", default="socket://127.0.0.1:5558")
    ap.add_argument("--baud", type=int, default=2_000_000)
    ap.add_argument("--file", default=None,
                    help="raw file (sync + pixels per frame, see gen_raw_game_data.py) to loop instead of the built-in scene")
    ap.add_argument("--frames", type=int, default=0, help="stop after N frames (0 = forever)")
    ap.add_argument("--delay", type=float, default=0.0, help="extra seconds between frames (testing)")
    args = ap.parse_args()

    fb = len(g.SYNC_HEADER) + g.W * g.H * g.BPP // 8
    if args.file:
        data = open(args.file, "rb").read()
        if len(data) % fb or data[:4] != g.SYNC_HEADER:
            raise SystemExit("%s is not a whole number of %d-byte frames starting with the sync word"
                             % (args.file, fb))
        packets = [data[i:i + fb] for i in range(0, len(data), fb)]
        print("loaded %d frames from %s" % (len(packets), args.file))
    else:
        print("Rendering %d frames..." % g.NUM_FRAMES)
        packets = [g.SYNC_HEADER + g.pack(g.make_frame(k)) for k in range(g.NUM_FRAMES)]
    print("%d bytes/frame on the wire" % len(packets[0]))

    while True:
        try:
            link = open_link(args.port, args.baud)
            break
        except (OSError, ValueError) as e:        # refused until the flowgraph is running
            print("waiting for %s (%s)" % (args.port, e))
            time.sleep(1.0)
    print("connected to", args.port)

    total = window = 0
    t0 = time.time()
    try:
        while args.frames == 0 or total < args.frames:
            link.write(packets[total % len(packets)])      # blocks when the link is full
            total += 1
            window += 1
            if args.delay:
                time.sleep(args.delay)
            if time.time() - t0 >= 1.0:
                print("sent %.1f frames/s" % (window / (time.time() - t0)))
                t0, window = time.time(), 0
    except (OSError, KeyboardInterrupt) as e:
        print("stopped:", e if isinstance(e, OSError) else "Ctrl-C")
    finally:
        try:
            link.close()
        except Exception:
            pass


if __name__ == "__main__":
    main()