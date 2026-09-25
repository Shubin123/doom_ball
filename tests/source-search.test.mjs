import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { searchSourceFiles } from '../ide/source-search.js';

const files = new Map([
  ['src/main.c', 'const int led = 13;\nled_toggle();\n// LED status\n'],
  ['src/config.h', '#define LED_PIN PC13\n#define UART_BAUD 115200\n'],
]);
const reader = (path) => files.get(path);

test('literal source search matches each matching line across files', async () => {
  const result = await searchSourceFiles([...files.keys()], 'led', { readFile: reader, concurrency: 1 });
  assert.deepEqual(result.matches.map(({ path, line }) => [path, line]), [
    ['src/main.c', 1], ['src/main.c', 2], ['src/main.c', 3], ['src/config.h', 1],
  ]);
  assert.equal(result.failed, 0);
  assert.equal(result.limitReached, false);
});

test('regex mode searches with regular expression syntax and reports source columns', async () => {
  const result = await searchSourceFiles([...files.keys()], 'LED(?:_| )(?:PIN|status)', { regex: true, readFile: reader, concurrency: 1 });
  assert.deepEqual(result.matches.map(({ path, line, column }) => [path, line, column]), [
    ['src/main.c', 3, 3], ['src/config.h', 1, 8],
  ]);
});

test('plain mode treats regex metacharacters as literal text', async () => {
  files.set('src/special.c', 'if (value == a.b) {}\nif (value == axb) {}');
  const result = await searchSourceFiles(['src/special.c'], 'a.b', { readFile: reader });
  assert.deepEqual(result.matches.map((match) => match.line), [1]);
  files.delete('src/special.c');
});

test('invalid regular expressions and empty queries fail clearly', async () => {
  await assert.rejects(searchSourceFiles([], '(', { regex: true, readFile: reader }), SyntaxError);
  await assert.rejects(searchSourceFiles([], '  ', { readFile: reader }), /Enter a word/);
});

test('unreadable files are counted while readable files still return matches', async () => {
  const result = await searchSourceFiles(['missing.c', 'src/config.h'], 'UART', {
    readFile: (path) => { if (!files.has(path)) throw new Error('missing'); return reader(path); },
    concurrency: 1,
  });
  assert.equal(result.matches.length, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.completed, 2);
});

test('search caps the result list and supports abandoning superseded searches', async () => {
  files.set('many.c', 'hit\nhit\nhit');
  const limited = await searchSourceFiles(['many.c'], 'hit', { readFile: reader, limit: 2, concurrency: 1 });
  assert.equal(limited.matches.length, 2);
  assert.equal(limited.limitReached, true);

  let current = true;
  const cancelled = await searchSourceFiles(['many.c', 'src/main.c'], 'hit', {
    readFile: reader, concurrency: 1, isCurrent: () => current,
    onProgress: () => { current = false; },
  });
  assert.equal(cancelled.completed, 1);
  assert.equal(cancelled.matches.length, 3);
  files.delete('many.c');
});

test('static IDE and Pages bundle expose the tested source search module', async () => {
  const [html, bundle, pagesHtml, pagesBundle, pagesModule] = await Promise.all([
    readFile(new URL('../index.html', import.meta.url), 'utf8'),
    readFile(new URL('../ide/forge.js', import.meta.url), 'utf8'),
    readFile(new URL('../docs/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../docs/ide/forge.js', import.meta.url), 'utf8'),
    readFile(new URL('../docs/ide/source-search.js', import.meta.url), 'utf8'),
  ]);
  assert.match(html, /id="source-search-form"/);
  assert.match(html, /id="source-search-regex"/);
  assert.match(bundle, /async function searchSourceFiles\(/);
  assert.match(bundle, /function searchSources\(/);
  assert.match(pagesHtml, /id="source-search-form"/);
  assert.match(pagesBundle, /async function searchSourceFiles\(/);
  assert.match(pagesModule, /export async function searchSourceFiles\(/);
});
