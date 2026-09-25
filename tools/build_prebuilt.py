#!/usr/bin/env python3
"""
Builds every target/project combination with the real toolchain and writes
firmware/prebuilt/<target>-<project>.bin plus manifest.json (linker memory
report, DOOM zone banks, result) and ide/files.json (source listing). The IDE uses these when it is opened
without the build server, e.g. from GitHub Pages.
"""
import base64
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'server'))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import forge_server  # noqa: E402

OUT = os.path.join(forge_server.ROOT, 'firmware', 'prebuilt')


def main():
    manifest = {'toolchain': forge_server.find_toolchain()[1], 'builds': {}}
    for target in forge_server.TARGETS:
        for project in forge_server.PROJECTS:
            key = '%s-%s' % (target, project)
            r = forge_server.build(target, project)
            entry = {k: r.get(k) for k in ('ok', 'memory', 'zone', 'zoneBanks', 'binarySize')}
            errors = [l.split(': ', 1)[-1] if l.startswith('/') else l
                      for l in r['log'].splitlines() if 'overflowed' in l or 'will not fit' in l]
            entry['errors'] = [e.replace(forge_server.ROOT + '/', '') for e in errors]
            if r['ok']:
                with open(os.path.join(OUT, key + '.bin'), 'wb') as f:
                    f.write(base64.b64decode(r['binary']))
            manifest['builds'][key] = entry
            print('%-16s %s' % (key, 'ok' if r['ok'] else 'FAILED (%s)' % '; '.join(errors[-2:])))
    with open(os.path.join(OUT, 'manifest.json'), 'w') as f:
        json.dump(manifest, f, indent=1)
    # Source listing for the IDE's read-only mode (no server).
    with open(os.path.join(forge_server.ROOT, 'ide', 'files.json'), 'w') as f:
        json.dump({'files': forge_server.file_tree()}, f, indent=0)


if __name__ == '__main__':
    main()
    import embed_assets  # noqa: E402
    embed_assets.main()
