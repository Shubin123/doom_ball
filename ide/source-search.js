// Search a virtual source tree through an injected file reader. Keeping the
// matcher independent from the DOM makes the static IDE's FS search testable.
export async function searchSourceFiles(paths, query, {
  regex = false, readFile, limit = 1000, concurrency = 8,
  isCurrent = () => true, onProgress = () => {},
} = {}) {
  if (!String(query).trim()) throw new Error('Enter a word or regular expression.');
  if (typeof readFile !== 'function') throw new TypeError('A source file reader is required.');
  const source = regex ? query : String(query).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(source, 'gi');
  const matches = [];
  let next = 0, completed = 0, failed = 0;
  const files = [...paths];
  const worker = async () => {
    while (next < files.length && matches.length < limit && isCurrent()) {
      const path = files[next++];
      try {
        const lines = String(await readFile(path)).split(/\r?\n/);
        for (let i = 0; i < lines.length && matches.length < limit; i++) {
          pattern.lastIndex = 0;
          const match = pattern.exec(lines[i]);
          if (match) matches.push({ path, line: i + 1, column: match.index, snippet: lines[i].trim() || lines[i] });
        }
      } catch { failed++; }
      completed++;
      if (isCurrent()) onProgress({ completed, total: files.length, matches: matches.length, failed });
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), files.length) }, worker));
  return { matches, completed, failed, limitReached: matches.length >= limit };
}
