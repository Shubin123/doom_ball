"""
DOOM 4-GFSK live viewer (ZMQ float symbols from GRC -> frames).

Key differences from the first version:
  * Works in the SYMBOL domain (2 bits/symbol), so header search is automatically
    symbol-aligned. No per-message np.packbits (which padded each ZMQ chunk and
    corrupted alignment).
  * Auto-calibrates slicer thresholds (handles RTL-SDR frequency offset / DC shift
    and wrong demod gain).
  * Searches for the sync header in both polarities and flips if inverted.
  * Tolerates a symbol error or two in the header.
  * Prints once-per-second diagnostics so you can see where it breaks.
"""
import time
import numpy as np
import zmq
import cv2
from numpy.lib.stride_tricks import sliding_window_view

# ---------------- config ----------------
ADDR = "tcp://127.0.0.1:5555"
WIDTH, HEIGHT = 160, 100
BPP = 4                                # bits per pixel: 2, 4 or 8; must match the generator
FRAME_BYTES = WIDTH * HEIGHT * BPP // 8
FRAME_SYMS = FRAME_BYTES * 4          # 4 symbols per byte

# Must match the transmitter exactly. Add both if unsure; the matching one is reported.
HEADERS = {
    "AABBCCDD": bytes([0xAA, 0xBB, 0xCC, 0xDD]),
    "DEADBEEF": bytes([0xDE, 0xAD, 0xBE, 0xEF]),
}
MAX_HDR_ERRORS = 1                     # symbol errors tolerated in the 16-symbol header

# Level index 0 = lowest frequency ... 3 = highest. Map level -> 2-bit symbol.
# Natural: [0,1,2,3]. Gray: [0,1,3,2]. Must match the transmitter's mapping.
LEVEL_TO_SYM = np.array([0, 1, 2, 3], dtype=np.uint8)

AUTO_LEVELS = True                     # estimate thresholds from the data
DEFAULT_THR = np.array([-0.66, 0.0, 0.66])
RECENT_MAX = 60000                     # floats kept for level estimation
SCALE = 6
# ----------------------------------------

SYM_TO_LEVEL = np.zeros(4, dtype=np.uint8)
SYM_TO_LEVEL[LEVEL_TO_SYM] = np.arange(4, dtype=np.uint8)
FLIP_TABLE = bytes([3, 2, 1, 0]) + bytes(range(4, 256))


def bytes_to_levels(b: bytes) -> np.ndarray:
    bits = np.unpackbits(np.frombuffer(b, dtype=np.uint8))
    sym = (bits[0::2] << 1) | bits[1::2]
    return SYM_TO_LEVEL[sym]


PATTERNS = []   # (label, level pattern, inverted?)
for name, hb in HEADERS.items():
    lv = bytes_to_levels(hb)
    PATTERNS.append((name, lv, False))
    PATTERNS.append((name + " (inverted)", (3 - lv).astype(np.uint8), True))
HDR_LEN = len(bytes_to_levels(next(iter(HEADERS.values()))))


def find_hit(buf: bytearray, start: int):
    """Earliest header match at index >= start, or None."""
    arr = np.frombuffer(buf, dtype=np.uint8)
    if len(arr) - start < HDR_LEN:
        return None
    win = sliding_window_view(arr[start:], HDR_LEN)
    best = None
    for label, pat, inv in PATTERNS:
        mism = (win != pat).sum(axis=1)
        hits = np.flatnonzero(mism <= MAX_HDR_ERRORS)
        if hits.size and (best is None or hits[0] + start < best[0]):
            best = (int(hits[0]) + start, label, inv)
    return best


def estimate_thresholds(recent: np.ndarray, old: np.ndarray):
    lo, hi = np.percentile(recent, [2, 98])
    if hi - lo < 0.05:                 # basically flat -> no usable signal
        return old, False
    # The four tones always demodulate to c + a * (-1, -1/3, 1/3, 1). Fit c and
    # a to the symbols (nearest level, then least squares) starting from the
    # current thresholds. Unlike spreading thresholds between percentiles,
    # this holds when the payload uses only some levels, e.g. dark colour
    # planes that are almost all level 0 and 1.
    ideal = np.array([-1.0, -1.0 / 3.0, 1.0 / 3.0, 1.0])
    c, a = old[1], (old[2] - old[0]) * 0.75
    for _ in range(4):
        idx = np.clip(np.rint(((recent - c) / a + 1.0) * 1.5), 0, 3).astype(np.int64)
        if np.unique(idx).size < 2:
            return old, False
        lv = ideal[idx]
        a, c = np.polyfit(lv, recent, 1)
        if a < 0.05:
            return old, False
    new = c + a * np.array([-2.0 / 3.0, 0.0, 2.0 / 3.0])
    return 0.7 * old + 0.3 * new, True


def main():
    ctx = zmq.Context()
    sock = ctx.socket(zmq.SUB)
    sock.connect(ADDR)
    sock.setsockopt_string(zmq.SUBSCRIBE, "")

    cv2.namedWindow("DOOM 4-GFSK Live Feed", cv2.WINDOW_NORMAL)
    cv2.imshow("DOOM 4-GFSK Live Feed", np.zeros((HEIGHT * SCALE, WIDTH * SCALE), np.uint8))

    buf = bytearray()                  # holds LEVELS (0..3), one per byte
    scan_pos = 0
    in_frame = False
    invert = False
    thr = DEFAULT_THR.copy()
    recent = np.zeros(0, dtype=np.float32)
    last_thr_update = 0.0

    # stats
    t0 = time.time()
    n_msgs = n_syms = frames = hdr_hits = hdr_clean = 0
    fmin, fmax, fsum = np.inf, -np.inf, 0.0
    lvl_hist = np.zeros(4, dtype=np.int64)
    last_label = "-"
    levels_ok = False

    while True:
        if sock.poll(30):
            raw = []
            while True:
                try:
                    msg = sock.recv(zmq.NOBLOCK)
                except zmq.Again:
                    break
                raw.append(msg[: len(msg) // 4 * 4])
            if raw:
                n_msgs += len(raw)
                x = np.frombuffer(b"".join(raw), dtype=np.float32)
                if x.size:
                    n_syms += x.size
                    fmin, fmax = min(fmin, float(x.min())), max(fmax, float(x.max()))
                    fsum += float(x.sum())
                    recent = np.concatenate((recent, x))[-RECENT_MAX:]
                    lv = np.digitize(x, thr).astype(np.uint8)
                    lvl_hist += np.bincount(lv, minlength=4)
                    if invert:
                        lv = 3 - lv
                    buf.extend(lv.tobytes())

        now = time.time()
        if AUTO_LEVELS and now - last_thr_update > 0.25 and recent.size > 5000:
            thr, levels_ok = estimate_thresholds(recent, thr)
            last_thr_update = now

        # ---- frame sync state machine ----
        while True:
            if not in_frame:
                hit = find_hit(buf, scan_pos)
                if hit is None:
                    keep = HDR_LEN - 1
                    if len(buf) > keep:
                        del buf[:len(buf) - keep]
                    scan_pos = 0
                    break
                idx, label, inv = hit
                hdr_hits += 1
                hdr_clean += (idx == 0)
                last_label = label
                del buf[:idx + HDR_LEN]
                if inv:
                    invert = not invert
                    buf = bytearray(bytes(buf).translate(FLIP_TABLE))
                scan_pos = 0
                in_frame = True
            else:
                if len(buf) < FRAME_SYMS:
                    break
                lv = np.frombuffer(bytes(buf[:FRAME_SYMS]), dtype=np.uint8)
                del buf[:FRAME_SYMS]
                s = LEVEL_TO_SYM[lv].reshape(-1, 4)
                img_bytes = (s[:, 0] << 6) | (s[:, 1] << 4) | (s[:, 2] << 2) | s[:, 3]
                bits = np.unpackbits(img_bytes.astype(np.uint8))
                pix = bits.reshape(-1, BPP) @ (1 << np.arange(BPP - 1, -1, -1))
                img = (pix * (255 // ((1 << BPP) - 1))).astype(np.uint8).reshape((HEIGHT, WIDTH))
                cv2.imshow("DOOM 4-GFSK Live Feed",
                           cv2.resize(img, (WIDTH * SCALE, HEIGHT * SCALE),
                                      interpolation=cv2.INTER_NEAREST))
                frames += 1
                in_frame = False
                scan_pos = 0

        if cv2.waitKey(1) & 0xFF == ord("q"):
            break

        # ---- diagnostics once per second ----
        if now - t0 >= 1.0:
            dt = now - t0
            if n_msgs == 0:
                print("[no ZMQ data]  is the flowgraph running / port 5555?")
            else:
                tot = max(1, lvl_hist.sum())
                print(
                    f"sym/s={n_syms/dt:9.0f} (want ~625000) | "
                    f"float min/max/mean={fmin:+.2f}/{fmax:+.2f}/{fsum/n_syms:+.2f} | "
                    f"thr={np.round(thr, 2)} auto_ok={levels_ok} | "
                    f"levels%={np.round(100*lvl_hist/tot).astype(int)} | "
                    f"hdr hits={hdr_hits} aligned={hdr_clean} ({last_label}) "
                    f"invert={invert} frames={frames} buf={len(buf)}"
                )
            t0 = now
            n_msgs = n_syms = frames = hdr_hits = hdr_clean = 0
            fmin, fmax, fsum = np.inf, -np.inf, 0.0
            lvl_hist[:] = 0

    cv2.destroyAllWindows()
    sock.close()
    ctx.term()


if __name__ == "__main__":
    main()
