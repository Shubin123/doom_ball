#!/usr/bin/env python3
"""
STM32 Forge local build server.

Serves the web IDE and gives it a real toolchain:

  GET  /api/status                 toolchain + targets
  GET  /api/tree                   editable source files
  GET  /api/file?path=...          read a file
  PUT  /api/file?path=...          save a file (body = contents)
  POST /api/build                  {"target": "h743"|"bluepill", "project": "doom"|"blinky"}
                                   -> compiler log, per-region memory usage from
                                      the linker, DOOM zone size, firmware image

Binds to 127.0.0.1 only. Standard library only.

  python3 server/forge_server.py [--port 8732]
  then open http://localhost:8732/
"""
import argparse
import base64
import glob
import json
import os
import re
import shutil
import subprocess
import sys
import threading
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
FIRMWARE = os.path.join(ROOT, 'firmware')

TARGETS = {
    'h743': {'name': 'STM32H743IITx', 'core': 'Cortex-M7 @ 400 MHz',
             'flash': 2048 * 1024, 'ram': 1024 * 1024},
    'bluepill': {'name': 'STM32F103C8T6 (Blue Pill)', 'core': 'Cortex-M3 @ 72 MHz',
                 'flash': 64 * 1024, 'ram': 20 * 1024},
}
PROJECTS = ['doom', 'blinky']

# Sources shown in the IDE file tree (vendored libraries are left out).
EDITABLE = [
    'firmware/projects/**/*.[ch]',
    'firmware/targets/**/*.[chs]',
    'firmware/targets/**/*.ld',
    'firmware/Makefile',
    'engine/platform/*.c',
    'engine/doomgeneric/*.[ch]',
]

build_lock = threading.Lock()


def find_toolchain():
    candidates = []
    if os.environ.get('ARM_GCC_PATH'):
        candidates.append(os.environ['ARM_GCC_PATH'])
    on_path = shutil.which('arm-none-eabi-gcc')
    if on_path:
        candidates.append(os.path.dirname(on_path))
    candidates += sorted(glob.glob(os.path.expanduser('~/.local/toolchains/*/bin')), reverse=True)
    candidates += sorted(glob.glob('/opt/*arm*/bin'), reverse=True)
    for d in candidates:
        gcc = os.path.join(d, 'arm-none-eabi-gcc')
        if os.path.isfile(gcc) and os.access(gcc, os.X_OK):
            try:
                ver = subprocess.run([gcc, '--version'], capture_output=True, text=True,
                                     timeout=10).stdout.splitlines()[0]
            except (OSError, subprocess.SubprocessError, IndexError):
                continue
            return d, ver
    return None, None


MEM_LINE = re.compile(r'^\s*(\w+):\s+(\d+(?:\.\d+)?)\s*([KMG]?B)\s+(\d+(?:\.\d+)?)\s*([KMG]?B)\s+')
OVERFLOW = re.compile(r"region [`'](\w+)' overflowed by (\d+) bytes")
UNITS = {'B': 1, 'KB': 1024, 'MB': 1024 ** 2, 'GB': 1024 ** 3}


def parse_memory(log):
    """Parses `ld --print-memory-usage` output into [{region, used, size}]."""
    regions = []
    for line in log.splitlines():
        m = MEM_LINE.match(line)
        if m and m.group(1) != 'Memory':
            regions.append({
                'region': m.group(1),
                'used': int(float(m.group(2)) * UNITS[m.group(3)]),
                'size': int(float(m.group(4)) * UNITS[m.group(5)]),
            })
    overflow = {m.group(1): int(m.group(2)) for m in OVERFLOW.finditer(log)}
    for r in regions:
        r['overflow'] = overflow.get(r['region'], 0)
    return regions


def zone_banks(bin_dir, elf):
    """Sizes of the DOOM zone heap banks from the linker symbols, or None."""
    try:
        out = subprocess.run([os.path.join(bin_dir, 'arm-none-eabi-nm'), elf],
                             capture_output=True, text=True, timeout=30).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    sym = {}
    for line in out.splitlines():
        parts = line.split()
        if len(parts) == 3 and re.fullmatch(r'__zone\d_(start|end)', parts[2]):
            sym[parts[2]] = int(parts[0], 16)
    banks = []
    i = 0
    while '__zone%d_start' % i in sym:
        banks.append(sym['__zone%d_end' % i] - sym['__zone%d_start' % i])
        i += 1
    return banks or None


def build(target, project):
    bin_dir, version = find_toolchain()
    if not bin_dir:
        return {'ok': False, 'log': 'arm-none-eabi-gcc not found. Install the Arm GNU Toolchain '
                'or set ARM_GCC_PATH to its bin directory.\n', 'memory': []}
    cmd = ['make', '-C', FIRMWARE, '-j%d' % (os.cpu_count() or 4),
           'TARGET=' + target, 'PROJECT=' + project, 'ARM_GCC_PATH=' + bin_dir]
    out_dir = os.path.join(FIRMWARE, 'build', '%s-%s' % (target, project))
    with build_lock:
        # Always relink so the linker prints the memory usage report.
        for name in ('firmware.elf', 'firmware.bin', 'firmware.hex'):
            try:
                os.remove(os.path.join(out_dir, name))
            except FileNotFoundError:
                pass
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=900)
    log = proc.stdout + proc.stderr
    result = {
        'ok': proc.returncode == 0,
        'toolchain': version,
        'command': ' '.join(cmd[:1] + cmd[3:-1]),
        'log': log,
        'memory': parse_memory(log),
    }
    if proc.returncode == 0:
        elf = os.path.join(out_dir, 'firmware.elf')
        with open(os.path.join(out_dir, 'firmware.bin'), 'rb') as f:
            image = f.read()
        result['binary'] = base64.b64encode(image).decode()
        result['binarySize'] = len(image)
        result['zoneBanks'] = zone_banks(bin_dir, elf)
        result['zone'] = sum(result['zoneBanks']) if result['zoneBanks'] else None
    return result


def safe_path(rel):
    """Absolute path for `rel` if it is one of the editable files, else None."""
    path = os.path.realpath(os.path.join(ROOT, rel))
    if not path.startswith(ROOT + os.sep) or os.path.relpath(path, ROOT) not in file_tree():
        return None
    return path


def file_tree():
    files = set()
    for pat in EDITABLE:
        for p in glob.glob(os.path.join(ROOT, pat), recursive=True):
            if os.path.isfile(p):
                files.add(os.path.relpath(p, ROOT))
    return sorted(files)


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def log_message(self, fmt, *args):
        if '/api/' in (args[0] if args else ''):
            sys.stderr.write('%s\n' % (fmt % args))

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def send_json(self, obj, status=HTTPStatus.OK):
        data = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def body(self):
        n = int(self.headers.get('Content-Length', 0))
        return self.rfile.read(n) if n else b''

    def do_GET(self):
        url = urlparse(self.path)
        if url.path == '/api/status':
            bin_dir, version = find_toolchain()
            return self.send_json({'toolchain': version, 'toolchainPath': bin_dir,
                                   'targets': TARGETS, 'projects': PROJECTS})
        if url.path == '/api/tree':
            return self.send_json({'files': file_tree()})
        if url.path == '/api/file':
            path = safe_path(parse_qs(url.query).get('path', [''])[0])
            if not path or not os.path.isfile(path):
                return self.send_json({'error': 'not found'}, HTTPStatus.NOT_FOUND)
            with open(path, encoding='utf-8', errors='replace') as f:
                return self.send_json({'path': os.path.relpath(path, ROOT), 'content': f.read()})
        return super().do_GET()

    def do_PUT(self):
        url = urlparse(self.path)
        if url.path != '/api/file':
            return self.send_json({'error': 'not found'}, HTTPStatus.NOT_FOUND)
        path = safe_path(parse_qs(url.query).get('path', [''])[0])
        if not path or not os.path.isfile(path):
            return self.send_json({'error': 'not an editable file'}, HTTPStatus.FORBIDDEN)
        with open(path, 'wb') as f:
            f.write(self.body())
        return self.send_json({'saved': os.path.relpath(path, ROOT)})

    def do_POST(self):
        if urlparse(self.path).path != '/api/build':
            return self.send_json({'error': 'not found'}, HTTPStatus.NOT_FOUND)
        try:
            req = json.loads(self.body() or b'{}')
        except json.JSONDecodeError:
            return self.send_json({'error': 'bad json'}, HTTPStatus.BAD_REQUEST)
        target, project = req.get('target'), req.get('project')
        if target not in TARGETS or project not in PROJECTS:
            return self.send_json({'error': 'unknown target/project'}, HTTPStatus.BAD_REQUEST)
        return self.send_json(build(target, project))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--port', type=int, default=8732)
    args = ap.parse_args()
    bin_dir, version = find_toolchain()
    print('STM32 Forge server on http://localhost:%d/' % args.port)
    print('toolchain: %s' % (version or 'NOT FOUND (set ARM_GCC_PATH)'))
    ThreadingHTTPServer(('127.0.0.1', args.port), Handler).serve_forever()


if __name__ == '__main__':
    main()
