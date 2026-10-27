"""
Raw byte stream -> 4-GFSK modulator, as a GNU Radio Embedded Python Block (source, no inputs).

Paste this whole file into a GRC "Python Block" and wire its complex output into your existing
chain (Complex Low Pass Filter, decimation 1, ...). Remove the File Source / RTL-SDR Source.
The block paces itself in real time, so a Throttle is not needed (an extra one is harmless).

What it does
    Bytes arriving on the link are modulated exactly as received: 2 bits per symbol, MSB
    first, 00 -> -1, 01 -> -1/3, 10 -> +1/3, 11 -> +1 (times `deviation`), rectangular pulses.
    No commands, no framing, no header added. The SENDER puts the frame sync word
    (AA BB CC DD) in front of every frame, exactly as in the original design.
    When no data is waiting the block sends an unmodulated carrier, so the stream never stops.

Link (port parameter; GRC passes it as typed, so 5558, "5558" and "tcp:5558" all mean TCP)
    "tcp:5558"             listen on 127.0.0.1:5558; a sender connects (doom_raw_sender.py)
    "COM7" / "/dev/ttyACM0" open that USB-serial port (a Pico running pico_raw_usb.py)
    The block stops reading when its buffer is full (max_buffer bytes, 0 = default 65536), so the sender is
    slowed to the real symbol rate by normal flow control (TCP window / USB).

samp_rate / symbol_rate must be an integer. Single-threaded: the link is polled from work().
"""
import select
import socket
import time

import numpy as np
from gnuradio import gr

LEAD = 1024            # samples the engine may run ahead of the wall clock
MIN_PRODUCE = 512
MAX_PRODUCE = 1024
UNIT_BYTES = 64        # bytes modulated per refill (64 bytes = 256 symbols = 1024 samples at 4 sps)
IDLE_SYMS = 64


class blk(gr.sync_block):
    def __init__(self, port="tcp:5558", samp_rate=2500000.0, symbol_rate=625000.0,
                 deviation=125000.0, gray=False, max_buffer=65536, realtime=False):
        gr.sync_block.__init__(self, name="Raw 4-GFSK Mod", in_sig=None,
                               out_sig=[np.complex64])
        sps = float(samp_rate) / float(symbol_rate)
        if abs(sps - round(sps)) > 1e-9 or round(sps) < 1:
            raise ValueError("samp_rate / symbol_rate must be an integer, got %r" % sps)
        self.sps = int(round(sps))
        self.fs = float(samp_rate)
        self.dev = float(deviation)
        # GRC passes parameters exactly as typed, so accept 5558, "5558" and "tcp:5558" as the
        # TCP port, and anything else ("COM7", "/dev/ttyACM0") as a serial port.
        p = str(port).strip().strip("'\"")
        if p.lower().startswith("tcp:"):
            p = p[4:]
        self._tcp_port = int(p) if p.isdigit() else None
        self.port = p
        mb = int(max_buffer) if str(max_buffer).strip() else 0
        self.max_buffer = mb if mb > 0 else 65536        # 0 / blank = default
        self.realtime = str(realtime).strip().lower() in ("1", "true", "yes")

        lv = np.array([-1.0, -1.0 / 3.0, 1.0 / 3.0, 1.0])
        sym_to_level = np.array([0, 1, 3, 2]) if gray else np.array([0, 1, 2, 3])
        self.sym_freq = lv[sym_to_level]
        self._idle = np.zeros(IDLE_SYMS)

        self.buf = bytearray()
        self.iq = np.zeros(0, dtype=np.complex64)
        self.phase = 0.0
        self.t0 = None
        self.emitted = 0
        self.bytes_in = 0
        self.bytes_mod = 0
        self.idle_syms = 0

        self._conn = None
        self._srv = None
        self._ser = None
        if self._tcp_port is not None:
            self._srv = socket.socket()
            self._srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            self._srv.bind(("127.0.0.1", self._tcp_port))
            self._srv.listen(1)
        else:
            import serial
            self._ser = serial.Serial(self.port, 115200, timeout=0)   # baud ignored by USB CDC
            self._ser.reset_input_buffer()

    # ---------------- link ----------------
    def _poll_link(self, timeout):
        """Read whatever has arrived (never blocks longer than `timeout` seconds)."""
        room = self.max_buffer - len(self.buf)
        if self._ser is not None:
            deadline = time.perf_counter() + max(0.0, timeout)
            while True:
                room = self.max_buffer - len(self.buf)
                try:
                    n = self._ser.in_waiting if room > 0 else 0
                    if n:
                        d = self._ser.read(min(n, room))
                        self.buf += d
                        self.bytes_in += len(d)
                except Exception as e:
                    print("[Raw 4-GFSK Mod] serial error:", e)
                    return
                if time.perf_counter() >= deadline:
                    return
                time.sleep(0.0002)
        socks = [self._srv] + ([self._conn] if self._conn is not None and room > 0 else [])
        try:
            ready, _, _ = select.select(socks, [], [], max(0.0, timeout))
        except (OSError, ValueError):
            return
        for sk in ready:
            if sk is self._srv:
                c, _ = sk.accept()
                if self._conn is not None:
                    self._conn.close()
                self._conn = c
                self.buf.clear()
                continue
            try:
                d = sk.recv(min(65536, room))
            except OSError:
                d = b""
            if not d:
                sk.close()
                self._conn = None
                continue
            self.buf += d
            self.bytes_in += len(d)

    # ---------------- modulator ----------------
    def _next_levels(self):
        if self.buf:
            data = bytes(self.buf[:UNIT_BYTES])
            del self.buf[:UNIT_BYTES]
            self.bytes_mod += len(data)
            bits = np.unpackbits(np.frombuffer(data, dtype=np.uint8))
            sym = (bits[0::2].astype(np.int64) << 1) | bits[1::2]
            return self.sym_freq[sym]
        self.idle_syms += IDLE_SYMS
        return self._idle                       # unmodulated carrier while no data waits

    def _refill(self, target):
        while self.iq.size < target:
            freq = np.repeat(self._next_levels(), self.sps) * self.dev
            phase = self.phase + 2.0 * np.pi * np.cumsum(freq) / self.fs
            self.phase = float(phase[-1] % (2.0 * np.pi))
            iq = np.exp(1j * np.mod(phase, 2.0 * np.pi)).astype(np.complex64)
            self.iq = np.concatenate((self.iq, iq))

    def work(self, input_items, output_items):
        out = output_items[0]
        n = len(out)
        if not self.realtime:                       # free-running: the Throttle sets the rate
            self._poll_link(0.0)
            k = min(n, 8192)
            self._refill(k)
            out[:k] = self.iq[:k]
            self.iq = self.iq[k:]
            self.emitted += k
            return k
        if self.t0 is None:
            self.t0 = time.perf_counter() - LEAD / self.fs
        while True:
            self._poll_link(0.0)
            now = time.perf_counter()
            allowed = int((now - self.t0) * self.fs) + LEAD - self.emitted
            if allowed > LEAD + 4 * MAX_PRODUCE:          # fell behind: drop the lag
                self.t0 = now - self.emitted / self.fs
                allowed = LEAD
            if allowed >= MIN_PRODUCE:
                break
            self._poll_link((MIN_PRODUCE - allowed) / self.fs)   # real-time wait that also reads the link
        k = max(1, min(n, MAX_PRODUCE, allowed))
        self._refill(k)
        out[:k] = self.iq[:k]
        self.iq = self.iq[k:]
        self.emitted += k
        return k

    def stop(self):
        for sk in (self._conn, self._srv, self._ser):
            try:
                if sk is not None:
                    sk.close()
            except Exception:
                pass
        print("[Raw 4-GFSK Mod] bytes in %d, modulated %d, idle %.2f s"
              % (self.bytes_in, self.bytes_mod, self.idle_syms / (self.fs / self.sps)))
        return True