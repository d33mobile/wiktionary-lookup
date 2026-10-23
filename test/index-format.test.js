import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildIndex } from '../build-index.js';
import { serializeIndex, deserializeIndex } from '../lib/index-format.js';
import { entries } from '../sources/cedict-text.js';
import { loadIndex } from '../lookup.js';
import { FIXTURE, countEntries, fullIndexAvailable, FULL_INDEX } from './helpers.js';

test('build -> write -> load keeps entry count and fields', async () => {
  const sections = await buildIndex(entries(FIXTURE));
  const dir = await mkdtemp(join(tmpdir(), 'wiktionary-lookup-'));
  const path = join(dir, 'mini.idx');
  await writeFile(path, serializeIndex(sections));
  const d = await loadIndex(path);
  assert.equal(d.size, await countEntries(FIXTURE));
  const original = [];
  for await (const e of entries(FIXTURE)) original.push(e);
  for (let i = 0; i < original.length; i++) {
    const { simp, trad, pinyin, definition } = d.entry(i);
    assert.deepEqual({ simp, trad, pinyin, definition }, original[i]);
  }
});

test('typed array views survive an unaligned buffer offset', async () => {
  const sections = await buildIndex(entries(FIXTURE));
  const bytes = serializeIndex(sections);
  const shifted = new Uint8Array(bytes.length + 1);
  shifted.set(bytes, 1);
  const d = deserializeIndex(shifted.subarray(1));
  assert.deepEqual([...d.orderSimp], [...sections.orderSimp]);
  assert.equal(d.blob, sections.blob);
});

test('rejects a file that is not an index', async () => {
  await assert.rejects(async () => deserializeIndex(await readFile(FIXTURE)), /not a wiktionary-lookup index/);
});

test('full CC-CEDICT index has the expected entry count', { skip: !fullIndexAvailable() && 'full index not built' }, async () => {
  const d = await loadIndex(FULL_INDEX);
  assert.ok(d.size > 100000, `${d.size} entries`);
});
