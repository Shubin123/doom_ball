#!/usr/bin/env node
// Assemble the GitHub Pages tree using Node only. Publish main:/docs in Pages settings.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const docs = path.join(root, 'docs');
const copy = async (from, to) => {
  await fs.rm(path.join(docs, to), { recursive: true, force: true });
  await fs.mkdir(path.dirname(path.join(docs, to)), { recursive: true });
  await fs.cp(path.join(root, from), path.join(docs, to), { recursive: true });
};

await fs.copyFile(path.join(root, 'index.html'), path.join(docs, 'index.html'));
await fs.copyFile(path.join(root, '.nojekyll'), path.join(docs, '.nojekyll'));
for (const folder of ['ide', 'sim', 'engine', 'vendor']) await copy(folder, folder);
await copy('firmware/targets', 'firmware/targets');
await copy('firmware/projects', 'firmware/projects');
await copy('firmware/third_party', 'firmware/third_party');
await copy('firmware/prebuilt', 'firmware/prebuilt');
await copy('firmware/Makefile', 'firmware/Makefile');

const editorRoots = ['engine', 'firmware/targets', 'firmware/projects', 'firmware/third_party'];
const files = [];
async function visit(relative) {
  for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
    const name = path.posix.join(relative, entry.name);
    if (entry.isDirectory()) await visit(name);
    else if (/\.(c|h|s|inc|ld|mk)$/.test(entry.name) || name === 'firmware/Makefile') files.push(name);
  }
}
for (const folder of editorRoots) await visit(folder);
files.sort();
const listing = `${JSON.stringify({ files }, null, 2)}\n`;
await fs.writeFile(path.join(root, 'ide/files.json'), listing);
await fs.writeFile(path.join(root, 'ide/files.js'), `window.FORGE_FILES=${JSON.stringify({ files })};\n`);
await fs.writeFile(path.join(docs, 'ide/files.json'), listing);
await fs.writeFile(path.join(docs, 'ide/files.js'), `window.FORGE_FILES=${JSON.stringify({ files })};\n`);
console.log(`Assembled static Pages site at docs/ (${files.length} IDE source files).`);
