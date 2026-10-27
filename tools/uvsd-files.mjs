// Source files of the UVic Satellite Design repositories under uvsd/ that the
// IDE lists and the Pages site publishes: the public DOOM balloon software
// repositories ("ide": true in uvsd/repos.json), files tracked by each
// submodule (not fetched SDKs or build output), text sources only.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const SOURCE = /(\.(c|h|s|ld|py|grc|ioc|md|rst|toml|sh|cmake|yml|yaml)|(^|\/)(Makefile|CMakeLists\.txt))$/;

export function uvsdRepos(root) {
  return JSON.parse(fs.readFileSync(path.join(root, 'uvsd/repos.json'), 'utf8')).repos;
}

export function uvsdSourceFiles(root) {
  const files = [];
  for (const repo of uvsdRepos(root)) {
    if (repo.private || !repo.ide) continue;
    const dir = path.join(root, 'uvsd', repo.id);
    if (!fs.existsSync(path.join(dir, '.git'))) continue;
    const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: dir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\0');
    for (const rel of tracked) if (rel && SOURCE.test(rel)) files.push(`uvsd/${repo.id}/${rel}`);
  }
  return files.sort();
}

// Data the balloon page reads besides sources: palettes and recorded gameplay.
export const UVSD_DATA = [
  'uvsd/repos.json',
  'uvsd/uvsd-doom-gs/assets/palettes.hex',
  'uvsd/uvsd-doom-gnu-radio/doom_raw.bin',
  'uvsd/uvsd-doom-gnu-radio/colour gameplay/doom_raw_rgb.bin',
];
