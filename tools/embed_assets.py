#!/usr/bin/env python3
"""
Writes <script>-loadable copies of the IDE's data files so the IDE also
works when index.html is opened straight from disk (file://), where the
browser blocks fetch():

  sim/doom1.wad.js              DOOM1.WAD, base64
  firmware/prebuilt/prebuilt.js manifest.json + prebuilt images, base64
  ide/files.js                  source listing
"""
import base64
import json
import os

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))


def b64(path):
    with open(path, 'rb') as f:
        return base64.b64encode(f.read()).decode()


def write(rel, text):
    with open(os.path.join(ROOT, rel), 'w') as f:
        f.write(text)
    print('wrote %s (%d KB)' % (rel, len(text) // 1024))


def main():
    write('sim/doom1.wad.js', 'window.FORGE_WAD_B64="%s";\n' % b64(os.path.join(ROOT, 'sim/doom1.wad')))

    pre = os.path.join(ROOT, 'firmware/prebuilt')
    with open(os.path.join(pre, 'manifest.json')) as f:
        manifest = json.load(f)
    images = {name[:-4]: b64(os.path.join(pre, name))
              for name in sorted(os.listdir(pre)) if name.endswith('.bin')}
    write('firmware/prebuilt/prebuilt.js', 'window.FORGE_PREBUILT=%s;\n' %
          json.dumps({'manifest': manifest, 'images': images}))

    with open(os.path.join(ROOT, 'ide/files.json')) as f:
        write('ide/files.js', 'window.FORGE_FILES=%s;\n' % f.read().strip())


if __name__ == '__main__':
    main()
