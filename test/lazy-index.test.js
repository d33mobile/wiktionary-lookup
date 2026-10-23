import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildIndex } from '../build-index.js';
import { serializeIndex, BlockCache, NeedBytes } from '../lib/index-format.js';
import {
  openIndex, openIndexLazy, openIndexProgressive, fetchRangeReader, nodeFileReader,
} from '../lookup.js';
import { entries as cedictEntries } from '../sources/cedict-text.js';
import { entryOf } from '../sources/wikipedia-titles.js';
import { FIXTURE as CEDICT_FIXTURE } from './helpers.js';
import { toByteOffsets } from '../scripts/index-byte-offsets.js';

const dir = mkdtempSync(join(tmpdir(), 'lazy-index-'));
after(() => rmSync(dir, { recursive: true, force: true }));

// Only what a search scans in memory: word and gloss tables on disk too.
const SCANNED = /^(order|rank$|formEntry$|audio)/;
const CEDICT_QUERIES = ['n', 'ni', 'nihao', 'zhong1 guo2', '中', '中国', 'man', 'shit', '/to be', 'p:ban', 'ba', 'what', 'hello'];
const TITLES = [
  'New York\t1000\tState of the United States\tNY state',
  'New York City\t8000\tMost populous city in the United States\tNYC\x1fBig Apple\x1fGotham',
  'Newark, New Jersey\t20\tCity in New Jersey\t',
  "O'Hare International Airport\t0\t\tORD\x1fChicago O'Hare",
  'Tokyo\t5000\tCapital of Japan\t東京\x1fTokio',
  'Zürich\t300\tLargest city in Switzerland\tZurich\x1fZuerich',
];
const TITLE_QUERIES = ['n', 'ne', 'new', 'new y', 'new york', 'nyc', 'got', '東京', 'tokio', 'zurich', 'capital', 'city', "o'h", 'united states'];

async function cedictFile() {
  const file = join(dir, 'cedict.idx');
  writeFileSync(file, serializeIndex(await buildIndex(cedictEntries(CEDICT_FIXTURE))));
  return file;
}

async function titlesFile() {
  const info = {};
  async function* rows() {
    info.language = { code: 'en', name: 'English', script: 'Latn', hasRomanization: false };
    info.keys = { headword: 'fold', romanization: 'fold' };
    info.textOffsets = 'bytes';
    info.entryUrl = 'https://en.wikipedia.org/wiki/{title}';
    for (const line of TITLES) yield entryOf(line);
  }
  const sections = await buildIndex(rows(), info);
  const file = join(dir, 'titles.idx');
  writeFileSync(file, serializeIndex(sections, info));
  return file;
}

// Types every query character by character in one session of each.
async function assertSameResults(eager, lazy, queries) {
  const se = eager.newSession();
  const sl = lazy.newSession();
  let hits = 0;
  for (const query of queries) {
    for (let k = 1; k <= query.length; k++) {
      const q = query.slice(0, k);
      const expected = se.search(q);
      hits += expected.length;
      assert.deepEqual(await sl.searchAsync(q), expected, q);
      assert.deepEqual(await lazy.newSession().searchAsync(q), expected, `${q} (fresh session)`);
    }
  }
  return hits;
}

for (const [name, make, queries] of [['CC-CEDICT fixture', cedictFile, CEDICT_QUERIES], ['Wikipedia titles', titlesFile, TITLE_QUERIES]]) {
  test(`openIndexLazy: ${name}, every section on disk, a tiny cache`, async () => {
    const file = await make();
    const eager = openIndex(readFileSync(file));
    const reader = await nodeFileReader(file);
    const lazy = await openIndexLazy(reader, { residentBytes: 0, resident: SCANNED, cache: { blockBytes: 256, maxBytes: 4096, spanBytes: 1024 } });
    assert.ok(lazy.blockCache);
    const hits = await assertSameResults(eager, lazy, queries);
    assert.ok(hits > 30, `${hits} hits`);
    assert.ok(lazy.blockCache.bytes <= 4096 + 1024, 'the cache stays near its limit');
    assert.ok(lazy.blockCache.reads > 3);
    await lazy.close();
  });

  test(`openIndexProgressive: ${name}, progress, searchable before the definition tables`, async () => {
    const file = await make();
    const eager = openIndex(readFileSync(file));
    const reader = await nodeFileReader(file);
    const seen = [];
    let partial = null;
    let partialResults = null;
    const d = await openIndexProgressive(reader, {
      chunkBytes: 512,
      onProgress: (p) => seen.push(p),
      onSearchable: (dict) => {
        partial = dict;
        partialResults = { head: dict.search(queries === TITLE_QUERIES ? 'new york' : 'nihao'), defs: dict.search('/city') };
      },
    });
    assert.ok(seen.length > 3);
    assert.equal(seen.at(-1).loaded, seen.at(-1).total);
    assert.ok(seen.every((p, i) => i === 0 || p.loaded > seen[i - 1].loaded));
    assert.notEqual(partial, d, 'a partial dictionary first');
    assert.ok(partialResults.head.length > 0, 'headwords searchable early');
    assert.deepEqual(partialResults.defs, [], 'definitions not yet');
    for (const q of queries) assert.deepEqual(d.search(q), eager.search(q), q);
    assert.equal(d.blockCache, undefined, 'an in-memory dictionary');
    await d.close();
  });

  test(`openIndexLazy: ${name}, searchable before the recordings and definition tables`, async () => {
    const file = await make();
    const eager = openIndex(readFileSync(file));
    const reader = await nodeFileReader(file);
    let partial = null;
    const order = [];
    const d = await openIndexLazy(reader, {
      residentBytes: 0,
      onProgress: (p) => { if (order.at(-1) !== p.section) order.push(p.section); },
      onSearchable: (dict) => { partial = dict; order.push('SEARCHABLE'); },
    });
    const at = order.indexOf('SEARCHABLE');
    assert.ok(at > 0 && at < order.length - 1, order.join(' '));
    assert.ok(order.slice(at + 1).every((n) => /^(audio|words|wordOffsets|postStart|postings|gloss)/.test(n)), order.join(' '));
    const q = queries === TITLE_QUERIES ? 'new york' : 'nihao';
    const head = await partial.searchAsync(q);
    assert.ok(head.length > 0, 'headwords searchable early, lazily');
    assert.deepEqual(head.map((r) => r.id), eager.search(q).filter((r) => r.matchedOn !== 'definition').map((r) => r.id).slice(0, head.length));
    for (const qq of queries) assert.deepEqual(await d.searchAsync(qq), eager.search(qq), qq);
    await d.close();
  });
}

test('BlockCache: NeedBytes until loaded, spans, eviction', async () => {
  const data = new Uint8Array(10000).map((_, i) => i % 251);
  const reader = { size: data.length, read: async (o, l) => data.slice(o, o + l) };
  const c = new BlockCache(reader, { blockBytes: 100, maxBytes: 1000, spanBytes: 300 });
  assert.throws(() => c.readSync(150, 100), NeedBytes);
  await c.load(150, 100);
  assert.deepEqual(c.readSync(150, 100), data.slice(150, 250));
  assert.equal(c.reads, 1, 'one read for two consecutive missing blocks');
  assert.throws(() => c.readSync(5000, 500), (e) => e instanceof NeedBytes && e.offset === 5000 && e.length === 500);
  await c.load(5000, 500);
  assert.deepEqual(c.readSync(5000, 500), data.slice(5000, 5500));
  await c.load(9950, 50);
  assert.deepEqual(c.readSync(9950, 50), data.slice(9950), 'the last, short block');
  for (let o = 0; o < 3000; o += 100) await c.load(o, 100);
  assert.ok(c.bytes <= 1000);
  await Promise.all([c.load(4000, 50), c.load(4010, 50)]);
  assert.ok(c.readSync(4000, 60));
});

test('fetchRangeReader: lazy search over HTTP Range requests; a server without Range fails clearly', async () => {
  const file = await titlesFile();
  const bytes = readFileSync(file);
  let rangeRequests = 0;
  const server = createServer((req, res) => {
    const m = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
    if (req.url === '/norange.idx' || !m) {
      res.writeHead(200, { 'Content-Length': bytes.length });
      res.end(req.method === 'HEAD' ? undefined : bytes);
      return;
    }
    rangeRequests++;
    const [start, end] = [Number(m[1]), Number(m[2])];
    res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${bytes.length}`, 'Content-Length': end - start + 1 });
    res.end(bytes.subarray(start, end + 1));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const reader = await fetchRangeReader(`${base}/titles.idx`);
    assert.equal(reader.size, bytes.length);
    const lazy = await openIndexLazy(reader, { residentBytes: 0, resident: SCANNED, cache: { blockBytes: 512 } });
    const eager = openIndex(bytes);
    await assertSameResults(eager, lazy, ['new york', '東京', 'capital']);
    assert.ok(rangeRequests > 3);
    const bad = await fetchRangeReader(`${base}/norange.idx`);
    await assert.rejects(openIndexLazy(bad), /HTTP 200 to a Range request/);
  } finally {
    server.close();
  }
});

test('index-byte-offsets: same results, and lazily readable', async () => {
  const file = await cedictFile();
  const units = readFileSync(file);
  const bytes = toByteOffsets(units);
  assert.equal(toByteOffsets(bytes), null, 'already converted');
  const a = openIndex(units);
  const b = openIndex(bytes);
  assert.equal(typeof b.blob, 'object');
  for (const q of CEDICT_QUERIES) assert.deepEqual(b.search(q), a.search(q), q);
  const converted = join(dir, 'cedict.bytes.idx');
  writeFileSync(converted, bytes);
  const lazy = await openIndexLazy(await nodeFileReader(converted), { residentBytes: 0 });
  await assertSameResults(a, lazy, CEDICT_QUERIES);
  await lazy.close();
});
