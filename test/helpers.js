import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildIndex } from '../build-index.js';
import { serializeIndex, deserializeIndex } from '../lib/index-format.js';
import { Dictionary } from '../lookup.js';
import { entries } from '../sources/cedict-text.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const FIXTURE = resolve(HERE, 'fixtures', 'mini-cedict.txt');
export const FULL_INDEX = process.env.LOOKUP_INDEX ?? 'data/cedict.idx';

export function fullIndexAvailable() {
  return existsSync(FULL_INDEX);
}

// Build from the fixture, then round-trip through the binary serialisation so
// tests exercise the same code path as loadIndex().
export async function fixtureDictionary() {
  const sections = await buildIndex(entries(FIXTURE));
  return new Dictionary(deserializeIndex(serializeIndex(sections)));
}

export async function countEntries(path) {
  let n = 0;
  for await (const _ of entries(path)) n++;
  return n;
}

export const ids = (rows) => rows.map((r) => r.id);
