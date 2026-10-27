"""Replays the recorded gameplay through the viewers and checks every frame
is shown.

Each viewer's main() runs unchanged, with zmq and cv2 replaced by stubs: the
ZMQ socket delivers the recording's symbols as Symbol Sync would (float32,
levels -1 -1/3 +1/3 +1, with noise, gain error and DC offset), the viewer's
clock advances at the 625 ksym/s link rate so its threshold updates happen as
often as on air, and cv2.imshow counts the frames.

    uv run --with numpy python tests/replay_recordings.py
"""
import contextlib
import importlib.util
import io
import sys
import types
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
SYMBOL_RATE = 625_000.0
MSG = 4096                      # floats per ZMQ message


def replay(viewer_path: Path, recording: Path, noise: float, gain: float, dc: float) -> tuple[int, int]:
    data = np.fromfile(recording, dtype=np.uint8)
    bits = np.unpackbits(data)
    sym = (bits[0::2] << 1) | bits[1::2]
    levels = np.array([-1.0, -1 / 3, 1 / 3, 1.0], dtype=np.float32)[sym]
    rng = np.random.default_rng(1)
    values = (gain * levels + dc + rng.normal(0, noise, levels.size)).astype(np.float32)
    msgs = [values[i:i + MSG].tobytes() for i in range(0, values.size, MSG)]
    state = {"i": 0, "frames": 0, "t": 1000.0, "burst": 0}

    class Again(Exception):
        pass

    class Socket:
        def connect(self, *_): pass
        def close(self, *_): pass
        def setsockopt_string(self, *_): pass
        def poll(self, *_): return state["i"] < len(msgs)

        def recv(self, *_):
            # Hand over messages in bursts of 16, like a busy PUB socket.
            if state["i"] >= len(msgs) or state["burst"] == 16:
                state["burst"] = 0
                raise Again()
            state["burst"] += 1
            msg = msgs[state["i"]]
            state["i"] += 1
            state["t"] += MSG / SYMBOL_RATE
            return msg

    def imshow(_name, img):
        if img.any():
            state["frames"] += 1

    zmq = types.SimpleNamespace(Context=lambda: types.SimpleNamespace(socket=lambda *_: Socket(), term=lambda: None),
                                SUB=0, SUBSCRIBE=0, NOBLOCK=0, Again=Again)
    cv2 = types.SimpleNamespace(namedWindow=lambda *_: None, WINDOW_NORMAL=0, imshow=imshow, INTER_NEAREST=0,
                                resize=lambda img, *_, **__: img, destroyAllWindows=lambda: None,
                                waitKey=lambda *_: ord("q") if state["i"] >= len(msgs) else -1)
    saved = {name: sys.modules.get(name) for name in ("zmq", "cv2")}
    sys.modules.update(zmq=zmq, cv2=cv2)
    try:
        spec = importlib.util.spec_from_file_location(viewer_path.stem, viewer_path)
        viewer = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(viewer)
        viewer.time = types.SimpleNamespace(time=lambda: state["t"], sleep=lambda *_: None)
        with contextlib.redirect_stdout(io.StringIO()):
            viewer.main()
    finally:
        for name, module in saved.items():
            if module is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = module
    return state["frames"], data.size // (viewer.FRAME_BYTES + 4)


CASES = [
    ("view_doom_zmq.py", "doom_raw.bin"),
    ("colour gameplay/view_doom_zmq_rgb.py", "colour gameplay/doom_raw_rgb.bin"),
]
CHANNELS = [  # noise, demod gain, DC offset (an RTL-SDR frequency error)
    (0.05, 1.0, 0.0),
    (0.08, 0.7, 0.15),
    (0.05, 1.3, -0.2),
]


def main() -> int:
    failed = False
    for viewer, recording in CASES:
        if (ROOT / recording).stat().st_size < 4096:
            print(f"SKIP {recording}: Git LFS pointer, run git lfs pull")
            continue
        for noise, gain, dc in CHANNELS:
            shown, total = replay(ROOT / viewer, ROOT / recording, noise, gain, dc)
            ok = shown >= total - 0.05 * total
            failed |= not ok
            print(f"{'PASS' if ok else 'FAIL'} {viewer}: {shown}/{total} frames "
                  f"(noise {noise}, gain {gain}, DC {dc:+})")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
