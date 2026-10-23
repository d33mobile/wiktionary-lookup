import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildIndex } from '../build-index.js';
import { serializeIndex, deserializeIndexWithHeader } from '../lib/index-format.js';
import { openIndex } from '../lib/engine.js';
import { codePointLength } from '../lib/normalize.js';
import { entries as zhEntries } from '../sources/wiktionary-zh.js';
import { entries as genericEntries } from '../sources/wiktionary.js';

// The Wiktionary sources emit entries sorted by headword key and ask for
// byte text offsets (lazy opening). Search results must be what they were
// with entries in file order: the same rows, in the same order up to
// entries that tie on every ranking criterion (where the id decides).
const fixture = (code) => resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures', `wiktionary-${code}.jsonl`);

async function both(source, code) {
  const out = {};
  for (const sort of [true, false]) {
    const info = {};
    const bytes = serializeIndex(await buildIndex(source(fixture(code), info, { sort }), info), info);
    out[sort ? 'sorted' : 'fileOrder'] = { d: openIndex(bytes), header: deserializeIndexWithHeader(bytes).header };
  }
  return out;
}

const row = (r) => `${r.simp}|${r.trad}|${r.pinyin}|${r.matchedOn}`;
const QUERIES = {
  zh: ['nihao', 'zhongguo', 'xuexi', 'ma', 'n', 'lv', '中', '學', 'what', 'study', '/tea', 'p:hua', 'hello', 'ren'],
  de: ['haus', 'h', 'house', 'tea', 'gro', 'strasse', '/home'],
  ru: ['дом', 'д', 'dom', 'moskva', 'tea', 'house', 'ёж'],
  ja: ['猫', 'neko', 'ねこ', 'tokyo', 'cat', 't', 'お'],
};
const sources = { zh: zhEntries, de: genericEntries, ru: genericEntries, ja: genericEntries };

for (const [code, queries] of Object.entries(QUERIES)) {
  test(`${code}: entries sorted by headword key give the same results`, async () => {
    const { sorted, fileOrder } = await both(sources[code], code);
    assert.equal(sorted.header.textOffsets, 'bytes');
    assert.equal(sorted.d.size, fileOrder.d.size);
    const heads = Array.from({ length: sorted.d.size }, (_, i) => sorted.d.keyFns.headword(sorted.d.field(i, 0)));
    assert.deepEqual(heads, [...heads].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)), 'ids follow the headword key');
    for (const q of queries) {
      const a = sorted.d.search(q, { limit: 1000 });
      const b = fileOrder.d.search(q, { limit: 1000 });
      assert.deepEqual(a.map(row).sort(), b.map(row).sort(), `${q}: same rows`);
      assert.deepEqual(a.map((r) => `${r.matchedOn} ${codePointLength(r.simp)}`), b.map((r) => `${r.matchedOn} ${codePointLength(r.simp)}`),
        `${q}: same order up to ties`);
    }
  });
}
