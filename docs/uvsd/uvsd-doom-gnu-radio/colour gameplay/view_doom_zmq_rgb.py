"""
Colour (planar RGB) live viewer for the 4-GFSK pipeline (ZMQ float symbols from GRC -> frames).

Frame on the wire = AA BB CC DD + R plane + G plane + B plane (see gen_raw_game_data_rgb.py).
Set WIDTH, HEIGHT and BPP below to match the generator (--bits). PLANES = 3 is colour;
PLANES = 1 turns this into the grayscale viewer again.

Same sync/diagnostics design as view_doom_zmq.py: symbol-domain frame sync, auto-calibrated
slicer thresholds, header search in both polarities, once-per-second diagnostics line.
"""
import time
import numpy as np
import zmq
import cv2
from numpy.lib.stride_tricks import sliding_window_view

# ---------------- config ----------------
ADDR = "tcp://127.0.0.1:5555"
WIDTH, HEIGHT = 320, 200
PLANES = 3                             # 3 = R, G, B planes; 1 = grayscale
BPP = 2                                # bits per sample (per colour channel); = --bits of the generator
FRAME_BYTES = PLANES * WIDTH * HEIGHT * BPP // 8
FRAME_SYMS = FRAME_BYTES * 4           # 4 symbols per byte

HEADERS = {
    "AABBCCDD": bytes([0xAA, 0xBB, 0xCC, 0xDD]),
    "DEADBEEF": bytes([0xDE, 0xAD, 0xBE, 0xEF]),
}
MAX_HDR_ERRORS = 1                     # symbol errors tolerated in the 16-symbol header

# Level index 0 = lowest frequency ... 3 = highest. Natural: [0,1,2,3]. Gray: [0,1,3,2].
# Must match the modulator block's `gray` setting (False = natural).
LEVEL_TO_SYM = np.array([0, 1, 2, 3], dtype=np.uint8)

AUTO_LEVELS = True
DEFAULT_THR = np.array([-0.66, 0.0, 0.66])
RECENT_MAX = 60000
SCALE = 3
# ----------------------------------------

SYM_TO_LEVEL = np.zeros(4, dtype=np.uint8)
SYM_TO_LEVEL[LEVEL_TO_SYM] = np.arange(4, dtype=np.uint8)
FLIP_TABLE = bytes([3, 2, 1, 0]) + bytes(range(4, 256))
_WEIGHTS = (1 << np.arange(BPP - 1, -1, -1)).astype(np.int64)


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


def decode_frame(levels: np.ndarray) -> np.ndarray:
    """FRAME_SYMS tone levels (0..3, polarity already fixed) -> image for cv2.imshow
    (BGR uint8 for PLANES=3, gray uint8 for PLANES=1)."""
    s = LEVEL_TO_SYM[levels]
    bits = np.empty(s.size * 2, dtype=np.uint8)
    bits[0::2] = s >> 1
    bits[1::2] = s & 1
    vals = bits.reshape(-1, BPP) @ _WEIGHTS                       # one sample per entry
    planes = (vals.reshape(PLANES, HEIGHT, WIDTH) * (255 // ((1 << BPP) - 1))).astype(np.uint8)
    if PLANES == 3:
        return np.dstack([planes[2], planes[1], planes[0]])       # R,G,B planes -> BGR
    return planes[0]


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

    shape = (HEIGHT * SCALE, WIDTH * SCALE) + ((3,) if PLANES == 3 else ())
    cv2.namedWindow("DOOM 4-GFSK Live Feed (RGB)", cv2.WINDOW_NORMAL)
    cv2.imshow("DOOM 4-GFSK Live Feed (RGB)", np.zeros(shape, np.uint8))

    buf = bytearray()                  # holds tone LEVELS (0..3), one per byte
    scan_pos = 0
    in_frame = False
    invert = False
    thr = DEFAULT_THR.copy()
    recent = np.zeros(0, dtype=np.float32)
    last_thr_update = 0.0

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
                img = decode_frame(lv)
                cv2.imshow("DOOM 4-GFSK Live Feed (RGB)",
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
