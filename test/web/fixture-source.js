// Source module for build-index.js over the small JSON-lines fixtures of the
// web test: {word, pos, glosses} per line -> one entry without romanization.
// A line {"language": {...}, "keys": {...}} instead fills the index header
// metadata (see lib/index-format.js).
import { readFile } from 'node:fs/promises';

export async function* entries(path, info = {}) {
  for (const line of (await readFile(path, 'utf8')).split('\n')) {
    if (!line.trim()) continue;
    const record = JSON.parse(line);
    if (record.language) {
      Object.assign(info, record);
      continue;
    }
    const { word, pos, glosses } = record;
    yield { simp: word, trad: word, pinyin: '', definition: `(${pos}) ${glosses.join('/')}` };
  }
}
