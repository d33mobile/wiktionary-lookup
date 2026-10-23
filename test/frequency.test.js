import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { buildIndex, frequencyRanks } from '../build-index.js';
import { serializeIndex } from '../lib/index-format.js';
import { openIndex, loadIndex } from '../lookup.js';
import { decodeMsgpack, loadWordfreq } from '../lib/wordfreq.js';
import { applyFrequencies } from '../sources/wiktionary-zh.js';

const simps = (rows) => rows.map((r) => r.simp);

test('frequency ranks: equal values share a rank, missing ones come last', () => {
  assert.deepEqual([...frequencyRanks([5.1, undefined, 6.3, 5.1, 2])], [1, 0xFFFF, 0, 1, 2]);
  assert.deepEqual([...frequencyRanks([undefined, undefined])], [0xFFFF, 0xFFFF]);
});

// A wordfreq cB list in MessagePack: [header, bucket 0, bucket 1, ...].
function msgpackList(buckets) {
  const parts = [0x90 | (buckets.length + 1), 0x82];
  const str = (s) => {
    const b = Buffer.from(s, 'utf8');
    parts.push(0xa0 | b.length, ...b);
  };
  str('format'); str('cB'); str('version'); parts.push(1);
  for (const words of buckets) {
    parts.push(0x90 | words.length);
    words.forEach(str);
  }
  return Uint8Array.from(parts);
}

test('wordfreq lists: decoded, bucket i = Zipf 9 - i/100', async () => {
  const bytes = msgpackList([['的'], [], ['什么', '我']]);
  assert.deepEqual(decodeMsgpack(bytes), [{ format: 'cB', version: 1 }, ['的'], [], ['什么', '我']]);
  const dir = await mkdtemp(join(tmpdir(), 'wordfreq-'));
  await writeFile(join(dir, 'zh.msgpack.gz'), gzipSync(bytes));
  const zipf = await loadWordfreq(join(dir, 'zh.msgpack.gz'));
  assert.deepEqual([...zipf], [['的', 9], ['什么', 8.98], ['我', 8.98]]);
});

test('Chinese: the first reading of a word gets its frequency, later ones less', () => {
  const list = [
    { trad: '什麼', simp: '什么', pinyin: 'shen2 me5' },
    { trad: '什麼', simp: '什么', pinyin: 'she2 me5' },
    { trad: '倽', simp: '倽', pinyin: 'sha4' },
  ];
  applyFrequencies(list, new Map([['什么', 6.3]]));
  assert.deepEqual(list.map((e) => e.freq), [6.3, 5.3, undefined]);
});

describe('frequency inside a tier (fixture)', async () => {
  const entries = [
    { simp: '倽', pinyin: 'sha4', definition: '(character) what/which/who/why' },
    { simp: '哪', pinyin: 'na3', definition: '(character) which; what/any', freq: 5.41 },
    { simp: '什么', pinyin: 'shen2 me5', definition: '(pron) (interrogative) what/something', freq: 6.3 },
    { simp: '吗', pinyin: 'ma5', definition: '(character) yes-no question particle/(dialectal) what', freq: 6.5 },
    { simp: '神', pinyin: 'shen2', definition: '(character) god', freq: 5.1 },
    { simp: '蜃', pinyin: 'shen4', definition: '(character) clam/(mythology) the shen, a monster' },
    { simp: '身体', pinyin: 'shen1 ti3', definition: '(noun) body', freq: 5.0 },
    { simp: '珅', pinyin: 'shen1', definition: '(character) a kind of jade' },
    { simp: '深', pinyin: 'shen1', definition: '(character) deep', freq: 4.87 },
  ];
  const d = openIndex(serializeIndex(await buildIndex(entries.map((e) => ({ trad: e.simp, ...e })))));

  test('a frequent word with a labelled first-sense gloss beats rare plain glosses', () => {
    assert.deepEqual(simps(d.search('what')), ['什么', '哪', '倽', '吗']);
  });

  test('pinyin syllables and prefixes by frequency, then length', () => {
    assert.deepEqual(simps(d.search('shen')), ['神', '深', '蜃', '珅', '什么', '身体']);
    assert.equal(d.search('shen')[2].matchedOn, 'pinyinBare', 'the restricted gloss "the shen" does not beat the syllable');
    assert.deepEqual(simps(d.search('/shen')), ['蜃']);
  });
});

const ZH_INDEX = process.env.WIKTIONARY_ZH_INDEX ?? '/mnt/biglinks/wiktionary/wiktionary-zh.idx';

describe('frequency on the Wiktionary Chinese index', { skip: !existsSync(ZH_INDEX) && `${ZH_INDEX} not built` }, async () => {
  const d = existsSync(ZH_INDEX) ? await loadIndex(ZH_INDEX) : null;
  const ranked = Boolean(d?.source?.frequency);

  test('English words list the common Chinese word first', { skip: !ranked && 'index without frequencies' }, () => {
    const expected = { what: '什么', I: '我', i: '我', good: '好', person: '人', big: '大', man: '人' };
    for (const [q, word] of Object.entries(expected)) assert.equal(d.search(q)[0].simp, word, q);
  });

  test('pinyin: shenme -> 什么, shen -> common characters first', { skip: !ranked && 'index without frequencies' }, () => {
    assert.equal(d.search('shenme')[0].simp, '什么');
    assert.equal(d.search('shenme')[0].pinyin, 'shen2 me5');
    // 神, 深 and 身 (Zipf 5.1, 4.9 and 4.7 in wordfreq) are all HSK words.
    assert.deepEqual(new Set(simps(d.search('shen', { limit: 3 }))), new Set(['神', '深', '身']));
    assert.ok(d.search('shen').every((r) => r.matchedOn === 'pinyinBare'));
  });

  test('"shit" still lists English before pinyin prefixes, 拉屎 first', { skip: !ranked && 'index without frequencies' }, () => {
    const rows = d.search('shit', { limit: 100 });
    assert.equal(rows[0].simp, '拉屎');
    const firstPinyin = rows.findIndex((r) => r.matchedOn !== 'definition');
    assert.ok(firstPinyin >= 20, `${firstPinyin}`);
  });
});
