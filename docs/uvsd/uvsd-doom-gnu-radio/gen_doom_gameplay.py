"""
Synthetic DOOM-style "gameplay" test file for the 4-GFSK pipeline (original raycaster,
no game assets). Designed for maximum frame rate over a 625 kbaud / 1.25 Mbps link.

Frame format (matches view_doom_zmq.py):
    SYNC_HEADER (4 bytes) + W*H*BPP/8 payload bytes, pixels packed MSB-first.

Frame rate = 1.25e6 / ((W*H*BPP/8 + 4) * 8):
    160x100, 4 bpp ->  ~19.5 fps  (default)
    160x100, 2 bpp ->  ~39 fps
    320x200, 2 bpp ->  ~9.7 fps

Output: doom_gameplay.cfile (complex64) for GRC File Source (Complex, Repeat = Yes,
then Throttle at 2.5e6). Set fsk_deviation_hz in GRC to DEVIATION below.
Keep W, H, BPP identical in view_doom_zmq.py.
"""
import numpy as np

# --- CONFIGURATION ---
W, H = 160, 100
BPP = 4                      # 2, 4 or 8
NUM_FRAMES = 120             # ~6 s loop at default settings (~125 MB file)
SYNC_HEADER = b"\xAA\xBB\xCC\xDD"

SAMPLE_RATE = 2_500_000.0
SYMBOL_RATE = 625_000.0
SPS = int(SAMPLE_RATE / SYMBOL_RATE)   # 4
DEVIATION = 125_000.0
OUTPUT_FILENAME = "doom_gameplay.cfile"
# ---------------------

HUD_H = 14
H3D = H - HUD_H
LEVELS = 1 << BPP

# 16x16 map: border walls (1), pillars (2)
GRID = np.zeros((16, 16), dtype=np.uint8)
GRID[0, :] = GRID[-1, :] = GRID[:, 0] = GRID[:, -1] = 1
for (gx, gy) in [(4, 4), (11, 4), (4, 11), (11, 11), (8, 8)]:
    GRID[gy, gx] = 2
for gx in range(3, 13):
    GRID[1, gx] = 1  # keep border solid; extra marker row (harmless)

BAYER = (np.array([[0, 8, 2, 10], [12, 4, 14, 6],
                   [3, 11, 1, 9], [15, 7, 13, 5]]) + 0.5) / 16.0
DITHER = np.tile(BAYER, (H // 4 + 1, W // 4 + 1))[:H, :W]


def render3d(px, py, ang):
    dx, dy = np.cos(ang), np.sin(ang)
    plx, ply = -dy * 0.66, dx * 0.66
    cam = 2.0 * np.arange(W) / W - 1.0
    rdx = dx + plx * cam
    rdy = dy + ply * cam
    rdx = np.where(np.abs(rdx) < 1e-9, 1e-9, rdx)
    rdy = np.where(np.abs(rdy) < 1e-9, 1e-9, rdy)

    mx = np.full(W, int(px))
    my = np.full(W, int(py))
    ddx, ddy = np.abs(1.0 / rdx), np.abs(1.0 / rdy)
    sx, sy = np.where(rdx < 0, -1, 1), np.where(rdy < 0, -1, 1)
    sdx = np.where(rdx < 0, (px - mx) * ddx, (mx + 1.0 - px) * ddx)
    sdy = np.where(rdy < 0, (py - my) * ddy, (my + 1.0 - py) * ddy)
    hit = np.zeros(W, dtype=bool)
    side = np.zeros(W, dtype=np.int64)

    for _ in range(40):
        active = ~hit
        stepx = active & (sdx < sdy)
        stepy = active & ~(sdx < sdy)
        sdx = np.where(stepx, sdx + ddx, sdx)
        mx = np.where(stepx, mx + sx, mx)
        sdy = np.where(stepy, sdy + ddy, sdy)
        my = np.where(stepy, my + sy, my)
        side = np.where(stepx, 0, np.where(stepy, 1, side))
        hit |= active & (GRID[my, mx] > 0)
        if hit.all():
            break

    dist = np.maximum(np.where(side == 0, sdx - ddx, sdy - ddy), 0.05)
    wallx = np.where(side == 0, py + dist * rdy, px + dist * rdx)
    wallx -= np.floor(wallx)
    ct = GRID[my, mx]

    lh = H3D / dist
    top = H3D / 2.0 - lh / 2.0
    y = np.arange(H3D)[:, None].astype(np.float64)
    wall = (y >= top) & (y < top + lh)
    v = (y - top) / lh

    brick = (((v * 4) % 1) < 0.10) | (((wallx * 4 + (np.floor(v * 4) % 2) * 0.5) % 1) < 0.08)
    shade = 1.0 / (1.0 + 0.35 * dist) * np.where(side == 1, 0.6, 1.0)
    base = shade * np.where(ct == 1, 0.8, 1.0)
    wall_img = base * np.where((ct == 1) & brick, 0.4, 1.0)

    half = H3D / 2.0
    ceil = 0.10 + 0.10 * (1.0 - y / half)
    floor = 0.15 + 0.35 * ((y - half) / half)
    bg = np.where(y < half, ceil, floor) * np.ones((1, W))
    return np.clip(np.where(wall, wall_img, bg), 0.0, 1.0)


def draw_overlay(img3d, k):
    cx = W // 2 + int(3 * np.sin(2 * np.pi * k * 3 / NUM_FRAMES))
    for r in range(18):                               # simple gun
        hw = 3 + r // 3
        img3d[H3D - 18 + r, cx - hw:cx + hw] = 0.75 if r % 2 else 0.55
    if k % 20 < 2:                                    # muzzle flash
        img3d[H3D - 28:H3D - 18, cx - 5:cx + 5] = 1.0
    img3d[H3D // 2 - 1:H3D // 2 + 2, W // 2] = 1.0    # crosshair
    img3d[H3D // 2, W // 2 - 1:W // 2 + 2] = 1.0
    return img3d


def hud(k):
    h = np.full((HUD_H, W), 0.22)
    for i in range(3):
        x0 = 8 + i * 50
        h[3:11, x0:x0 + 36] = 0.5
        fill = int(36 * (0.3 + 0.7 * abs(np.sin(2 * np.pi * (k + i * 17) / NUM_FRAMES))))
        h[4:10, x0:x0 + fill] = 0.9
    return h


def make_frame(k):
    t = 2 * np.pi * k / NUM_FRAMES
    px, py = 8.0 + 3.0 * np.cos(t), 8.0 + 3.0 * np.sin(t)
    ang = t + np.pi / 2 + 0.6 * np.sin(3 * t)
    img = np.vstack([draw_overlay(render3d(px, py, ang), k), hud(k)])
    q = np.floor(img * (LEVELS - 1) + DITHER).clip(0, LEVELS - 1).astype(np.int64)
    return q


def pack(q):
    bits = ((q.reshape(-1, 1) >> np.arange(BPP - 1, -1, -1)) & 1).astype(np.uint8).ravel()
    return np.packbits(bits).tobytes()


levels_fsk = np.array([-1.0, -1.0 / 3.0, 1.0 / 3.0, 1.0])
frame_bytes = W * H * BPP // 8
frame_bits = (frame_bytes + len(SYNC_HEADER)) * 8
print(f"{W}x{H} @ {BPP} bpp -> {frame_bytes} B/frame, "
      f"{SYMBOL_RATE * 2 / frame_bits:.1f} fps over the link")

phase0 = 0.0
first_check = None
with open(OUTPUT_FILENAME, "wb") as f:
    for k in range(NUM_FRAMES):
        q = make_frame(k)
        packet = SYNC_HEADER + pack(q)
        bits = np.unpackbits(np.frombuffer(packet, dtype=np.uint8))
        sym = (bits[0::2].astype(np.int64) << 1) | bits[1::2]
        freq = np.repeat(levels_fsk[sym], SPS) * DEVIATION
        phase = phase0 + 2.0 * np.pi * np.cumsum(freq) / SAMPLE_RATE
        phase0 = float(phase[-1] % (2.0 * np.pi))
        iq = np.exp(1j * np.mod(phase, 2.0 * np.pi)).astype(np.complex64)
        iq.tofile(f)
        if k == 0:
            first_check = iq
            try:
                import cv2
                cv2.imwrite("doom_gameplay_preview.png",
                            cv2.resize((q * (255 // (LEVELS - 1))).astype(np.uint8),
                                       (W * 4, H * 4), interpolation=cv2.INTER_NEAREST))
            except Exception:
                pass

d = np.angle(first_check[1:] * np.conj(first_check[:-1])) * SAMPLE_RATE / (2 * np.pi * DEVIATION)
print(f"Wrote {OUTPUT_FILENAME}: {NUM_FRAMES} frames, "
      f"{NUM_FRAMES * frame_bits / SYMBOL_RATE / 2:.1f} s per loop")
print("demod check min/max:", float(d.min()), float(d.max()), "(expect about +-1)")
