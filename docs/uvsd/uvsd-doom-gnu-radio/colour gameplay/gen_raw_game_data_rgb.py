"""
Colour (planar RGB) raw game data at 320x200 for the raw 4-GFSK modulator: doom_raw_rgb.bin.

Same original raycaster scene as gen_raw_game_data.py (no DOOM assets), now in colour:
red brick, blue-grey metal panels, green columns, red creatures with yellow eyes, a grey pistol
with a muzzle flash, coloured HUD bars.

The colours are broken up into three palettes, one per channel. Each channel is quantised to
2**BITS levels (BITS=2 -> 4 levels per channel -> 64 colours) with ordered dithering, and the
three channels are sent as separate planes, one after the other.

Frame on the wire = AA BB CC DD + R plane + G plane + B plane
    plane = W*H samples of BITS bits, row-major, MSB first, packed into bytes
    size  = 4 + 3*W*H*BITS/8 bytes  (BITS=2 -> 48004 bytes)

The link carries about 156 kB/s, so the frame rate is 1.25e6 / (8 * frame size):
    BITS=1 ->  8 colours  ->  6.5 fps
    BITS=2 -> 64 colours  ->  3.3 fps   (default)
    BITS=3 -> 512 colours ->  2.2 fps
    BITS=4 -> 4096 colours -> 1.6 fps

Usage:   python gen_raw_game_data_rgb.py [--frames 160] [--bits 2] [--out doom_raw_rgb.bin]
Play it: python doom_raw_sender.py --file doom_raw_rgb.bin      (frame size is detected)
View it: python view_doom_zmq_rgb.py                            (keep BITS equal to --bits)
"""
import argparse
import numpy as np

W, H = 320, 200
S = W // 160                 # scale relative to the 160x100 scene
HUD_H = 14 * S
H3D = H - HUD_H
SYNC = b"\xAA\xBB\xCC\xDD"

# ---------------------------------------------------------------- map
N = 16
GRID = np.zeros((N, N), dtype=np.uint8)
GRID[0, :] = GRID[-1, :] = GRID[:, 0] = GRID[:, -1] = 1               # brick border
for bx, by in [(3, 3), (10, 3), (3, 10), (10, 10)]:                   # metal wall blocks (3x3)
    GRID[by:by + 3, bx:bx + 3] = 2
for px_, py_ in [(8, 3), (8, 12), (3, 8), (12, 8), (8, 8)]:           # columns
    GRID[py_, px_] = 3

WAYPOINTS = [(1.5, 1.5), (7.0, 1.5), (14.4, 1.5), (14.4, 7.0), (14.4, 14.4), (9.5, 14.4),
             (9.5, 9.5), (9.5, 6.5), (6.5, 6.5), (6.5, 9.5), (6.5, 14.4), (1.5, 14.4),
             (1.5, 7.0)]
ENEMIES = [(10.5, 1.5, 0), (14.4, 10.0, 8), (7.6, 12.5, 16), (1.5, 11.0, 24), (4.5, 6.5, 4),
           (8.0, 6.0, 12)]

WALL_RGB = np.array([[0, 0, 0], [0.92, 0.45, 0.32], [0.50, 0.64, 0.85], [0.40, 0.82, 0.62]])
CEIL_RGB = np.array([0.55, 0.65, 1.00])
FLOOR_RGB = np.array([1.00, 0.85, 0.65])
CREATURE_RGB = np.array([1.00, 0.30, 0.18])

BAYER = (np.array([[0, 8, 2, 10], [12, 4, 14, 6],
                   [3, 11, 1, 9], [15, 7, 13, 5]]) + 0.5) / 16.0
DITHER = np.tile(BAYER, (H // 4 + 1, W // 4 + 1))[:H, :W]


def path_point(t):
    pts = np.array(WAYPOINTS + [WAYPOINTS[0]], dtype=float)
    seg = np.hypot(*np.diff(pts, axis=0).T)
    cum = np.concatenate(([0.0], np.cumsum(seg)))
    s = (t % 1.0) * cum[-1]
    i = min(int(np.searchsorted(cum, s, side="right") - 1), len(seg) - 1)
    u = (s - cum[i]) / seg[i]
    return pts[i] + u * (pts[i + 1] - pts[i])


def camera(k, n):
    t = k / n
    p = path_point(t)
    ahead = np.mean([path_point(t + d) for d in (0.012, 0.022, 0.032)], axis=0)
    ang = np.arctan2(ahead[1] - p[1], ahead[0] - p[0]) + 0.28 * np.sin(2 * np.pi * t * 9)
    return p[0], p[1], ang


# ---------------------------------------------------------------- textures (brightness 0..1)
def wall_shade(ct, wallx, v):
    if ct == 1:                                                       # bricks
        row = np.floor(v * 8)
        off = (row % 2) * 0.5
        mortar = (((v * 8) % 1) < 0.12) | (((wallx * 4 + off) % 1) < 0.07)
        return np.where(mortar, 0.35, 0.80)
    if ct == 2:                                                       # metal panels
        groove = ((wallx * 4) % 1 < 0.06) | ((v * 4) % 1 < 0.05)
        rivet = (((wallx * 4) % 1 - 0.5) ** 2 + (((v * 4) % 1) - 0.5) ** 2) < 0.012
        return np.where(groove, 0.30, np.where(rivet, 1.0, 0.62))
    return 0.45 + 0.5 * np.abs(np.sin(wallx * np.pi * 6))            # fluted column


# ---------------------------------------------------------------- sprites
def creature(u, v, hit):
    """Returns (mask, rgb) for a creature on a (u, v) grid in [0, 1]^2."""
    cx, cy = u - 0.5, v - 0.55
    body = (cx / 0.34) ** 2 + (cy / 0.42) ** 2 < 1.0
    horn = ((np.abs(cx + 0.22) < 0.05) & (v < 0.22) & (v > 0.05)) | \
           ((np.abs(cx - 0.22) < 0.05) & (v < 0.22) & (v > 0.05))
    eyes = (((cx + 0.12) ** 2 + (cy + 0.12) ** 2) < 0.012) | (((cx - 0.12) ** 2 + (cy + 0.12) ** 2) < 0.012)
    mouth = (np.abs(cy - 0.12) < 0.03) & (np.abs(cx) < 0.15)
    shade = np.clip(0.55 + 0.45 * (1.0 - np.abs(cx) / 0.34), 0.3, 1.0)[..., None]
    rgb = shade * CREATURE_RGB
    rgb = np.where((horn & ~body)[..., None], np.array([0.85, 0.80, 0.70]), rgb)
    rgb = np.where(eyes[..., None], np.array([1.00, 0.92, 0.25]), rgb)
    rgb = np.where(mouth[..., None], np.array([0.12, 0.02, 0.02]), rgb)
    if hit:
        rgb = np.where((eyes | mouth)[..., None], np.array([0.8, 0.8, 0.8]), shade * np.ones(3))
    return body | horn, rgb


def alive_state(k, phase):
    """0 idle, 1 being hit (flash), 2 gone."""
    c = (k + phase) % 30
    if c < 20:
        return 0
    if c < 22:
        return 1
    if c < 28:
        return 2
    return 0


def rect(img, y0, y1, x0, x1, color):
    y0, y1 = max(int(y0), 0), min(int(y1), img.shape[0])
    x0, x1 = max(int(x0), 0), min(int(x1), img.shape[1])
    if y0 < y1 and x0 < x1:
        img[y0:y1, x0:x1] = color


# ---------------------------------------------------------------- renderer
def render3d(px, py, ang, k):
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
    v = np.clip((y - top) / lh, 0, 1)

    tex = np.zeros((H3D, W))
    for t in (1, 2, 3):
        tex = np.where((ct == t)[None, :], wall_shade(t, np.broadcast_to(wallx, (H3D, W)), v), tex)
    bright = tex * (1.0 / (1.0 + 0.30 * dist)) * np.where(side == 1, 0.65, 1.0)
    wall_rgb = bright[..., None] * WALL_RGB[ct][None, :, :]

    half = H3D / 2.0
    ceilb = 0.06 + 0.10 * (1.0 - y / half)
    floorb = (0.10 + 0.40 * ((y - half) / half)) * (1.0 - 0.15 * (np.floor(y / (0.5 * S)) % 2))
    bg = np.where(y < half, ceilb * CEIL_RGB, floorb * FLOOR_RGB)          # (H3D, 3)
    bg = bg[:, None, :] * np.ones((1, W, 1))
    img = np.where(wall[..., None], wall_rgb, bg)

    # sprites, far to near, occluded by walls per column
    inv_det = 1.0 / (plx * dy - dx * ply)
    sprites = []
    for ex, ey, ph in ENEMIES:
        wob = 0.15 * np.sin(2 * np.pi * (k + ph) / 12)
        sprites.append((ex + wob, ey, alive_state(k, ph)))
    sprites.sort(key=lambda s_: -((s_[0] - px) ** 2 + (s_[1] - py) ** 2))
    for sx_, sy_, state in sprites:
        if state == 2:
            continue
        relx, rely = sx_ - px, sy_ - py
        tx = inv_det * (dy * relx - dx * rely)
        ty = inv_det * (-ply * relx + plx * rely)
        if ty < 0.5:                       # too close: would fill the screen
            continue
        screen_x = int((W / 2) * (1 + tx / ty))
        size = int(abs(H3D / ty) * 0.75)
        if size < 2:
            continue
        x0, x1 = screen_x - size // 2, screen_x + size // 2
        y0 = int(H3D / 2 - size / 2 + size * 0.15)
        y1 = y0 + size
        xs = np.arange(max(x0, 0), min(x1, W))
        ys = np.arange(max(y0, 0), min(y1, H3D))
        if xs.size == 0 or ys.size == 0:
            continue
        u = (xs - x0) / max(1, (x1 - x0))
        vv = (ys - y0) / max(1, (y1 - y0))
        U, V = np.meshgrid(u, vv)
        mask, rgb = creature(U, V, state == 1)
        vis = mask & (ty < dist[xs])[None, :]
        patch = img[ys[0]:ys[-1] + 1, xs[0]:xs[-1] + 1]
        fogf = 0.5 + 0.5 * min(1.0, 2.0 / ty)
        img[ys[0]:ys[-1] + 1, xs[0]:xs[-1] + 1] = np.where(vis[..., None], rgb * fogf, patch)
    return np.clip(img, 0.0, 1.0)


def overlay(img, k):
    bob = int(round(1.5 * np.sin(k * 0.9))) * S
    cx = W // 2 + int(round(3 * np.sin(k * 0.45))) * S
    firing = (k % 8) < 1
    for r in range(22 * S):                                            # pistol
        hw = S * (2 + (r // S) // 4)
        yy = H3D - 22 * S + r + bob + (2 * S if firing else 0)
        col = (0.80, 0.80, 0.86) if (r // S) % 3 else (0.50, 0.50, 0.56)
        rect(img, yy, yy + 1, cx - hw, cx + hw, col)
    if firing:                                                         # muzzle flash
        fy = H3D - 33 * S + bob
        rect(img, fy, fy + 11 * S, cx - 6 * S, cx + 6 * S, (1.0, 0.90, 0.45))
        rect(img, fy - 3 * S, fy, cx - 3 * S, cx + 3 * S, (1.0, 1.0, 0.85))
    cross = (1.0, 1.0, 0.7)                                            # crosshair
    rect(img, H3D // 2 - 2 * S, H3D // 2 + 3 * S, W // 2, W // 2 + S, cross)
    rect(img, H3D // 2, H3D // 2 + S, W // 2 - 2 * S, W // 2 + 3 * S, cross)
    return img


def hud(k, n):
    h = np.zeros((HUD_H, W, 3))
    h[:] = (0.16, 0.16, 0.20)
    rect(h, 0, S, 0, W, (0.50, 0.50, 0.56))
    health = 0.35 + 0.6 * (0.5 + 0.5 * np.cos(2 * np.pi * k / n))
    ammo = 1.0 - ((k % 40) / 40.0)
    for x0, frac, col in ((6 * S, health, (0.92, 0.15, 0.15)), (110 * S, ammo, (0.95, 0.80, 0.20))):
        rect(h, 4 * S, 11 * S, x0, x0 + 44 * S, (0.30, 0.30, 0.36))
        rect(h, 5 * S, 10 * S, x0 + S, x0 + S + int(42 * S * frac), col)
    rect(h, 2 * S, 13 * S, 72 * S, 88 * S, (0.90, 0.70, 0.55))         # face
    rect(h, 4 * S, 7 * S, 75 * S, 78 * S, (0.05, 0.05, 0.10))
    rect(h, 4 * S, 7 * S, 82 * S, 85 * S, (0.05, 0.05, 0.10))
    rect(h, 10 * S, 11 * S, 76 * S, 84 * S, (0.30, 0.05, 0.05))
    if (k % 8) < 1:
        rect(h, 9 * S, 11 * S, 76 * S, 84 * S, (0.95, 0.85, 0.80))
    return h


def make_frame(k, n, levels):
    px, py, ang = camera(k, n)
    img = np.vstack([overlay(render3d(px, py, ang, k), k), hud(k, n)])
    return np.floor(img * (levels - 1) + DITHER[..., None]).clip(0, levels - 1).astype(np.int64)


def pack_planes(q, bits):
    """q: (H, W, 3) ints -> R plane + G plane + B plane, each packed MSB first."""
    shifts = np.arange(bits - 1, -1, -1)
    out = []
    for c in range(3):
        b = ((q[..., c].reshape(-1, 1) >> shifts) & 1).astype(np.uint8).ravel()
        out.append(np.packbits(b).tobytes())
    return b"".join(out)


# ---------------------------------------------------------------- keep the sync word out of the pixels
def _hdr_patterns():
    """Symbol patterns the viewer searches for: both headers, both polarities."""
    pats = []
    for hb in (b"\xAA\xBB\xCC\xDD", b"\xDE\xAD\xBE\xEF"):
        p = np.array([(b >> sh) & 3 for b in hb for sh in (6, 4, 2, 0)], dtype=np.uint8)
        pats += [p, (3 - p).astype(np.uint8)]
    return pats


HDR_PATTERNS = _hdr_patterns()
TOL = 1                      # the viewer tolerates 1 symbol error in the 16-symbol header


def to_symbols(data):
    bits = np.unpackbits(np.frombuffer(data, dtype=np.uint8))
    return ((bits[0::2] << 1) | bits[1::2]).astype(np.uint8)


def from_symbols(sym):
    s4 = sym.reshape(-1, 4).astype(np.uint8)
    return ((s4[:, 0] << 6) | (s4[:, 1] << 4) | (s4[:, 2] << 2) | s4[:, 3]).astype(np.uint8).tobytes()


def find_hits(sym, tol, chunk=1_000_000):
    """(start index, pattern) of every 16-symbol window within `tol` mismatches of a header."""
    out = []
    for c0 in range(0, max(1, len(sym) - 15), chunk):
        seg = sym[c0:c0 + chunk + 15]
        if len(seg) < 16:
            break
        win = np.lib.stride_tricks.sliding_window_view(seg, 16)
        for pat in HDR_PATTERNS:
            idx = np.flatnonzero((win != pat).sum(axis=1) <= tol)
            out += [(int(i) + c0, pat) for i in idx]
    out.sort(key=lambda t: t[0])
    return out


def scrub(payload):
    """Nudge samples by one level wherever the pixel data could be mistaken for a sync word."""
    sym = to_symbols(payload)
    fixes = 0
    for _ in range(50):
        hits = find_hits(sym, TOL + 1)
        if not hits:
            break
        last_end = -1
        for i, pat in hits:
            if i < last_end:                       # overlaps one handled this pass: next pass
                continue
            mism = int((sym[i:i + 16] != pat).sum())
            same = [j for j in range(16) if sym[i + j] == pat[j]]
            for j in same[:(TOL + 2) - mism]:
                sym[i + j] ^= 1
            last_end = i + 16
            fixes += 1
    return from_symbols(sym), fixes


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--frames", type=int, default=160)
    ap.add_argument("--bits", type=int, default=2, choices=(1, 2, 3, 4), help="bits per colour channel")
    ap.add_argument("--out", default="doom_raw_rgb.bin")
    args = ap.parse_args()
    levels = 1 << args.bits

    for k in range(args.frames):                    # the walk must stay in free space
        x, y, _ = camera(k, args.frames)
        for ox in (-0.25, 0.25):
            for oy in (-0.25, 0.25):
                assert GRID[int(y + oy), int(x + ox)] == 0, "path hits a wall at frame %d" % k

    frame_bytes = 3 * W * H * args.bits // 8
    fixed = 0
    with open(args.out, "wb") as f:
        for k in range(args.frames):
            payload, nfix = scrub(pack_planes(make_frame(k, args.frames, levels), args.bits))
            fixed += nfix
            assert len(payload) == frame_bytes
            f.write(SYNC + payload)
            if (k + 1) % 20 == 0:
                print("  %d / %d frames" % (k + 1, args.frames), flush=True)
    size = args.frames * (frame_bytes + 4)
    sym = to_symbols(open(args.out, "rb").read())
    fs = (frame_bytes + 4) * 4
    real = {k * fs for k in range(args.frames)}
    extra = [i for i, _ in find_hits(sym, TOL) if i not in real]
    assert not extra, "false sync patterns left at symbol offsets %r" % extra[:5]
    air = size * 8 / 1.25e6
    print("wrote %s: %d frames of %dx%d, %d bits/channel (%d colours), %d bytes/frame = %.2f MB"
          % (args.out, args.frames, W, H, args.bits, levels ** 3, frame_bytes + 4, size / 1e6))
    print("%d samples nudged; no false sync patterns. Airtime %.1f s per loop = %.2f fps at 1.25 Mbps"
          % (fixed, air, args.frames / air))


if __name__ == "__main__":
    main()
