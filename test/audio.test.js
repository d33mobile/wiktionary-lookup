import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildIndex } from '../build-index.js';
import { serializeIndex, deserializeIndexWithHeader } from '../lib/index-format.js';
import { openIndex, AUDIO_URL_PREFIX } from '../lookup.js';
import { entries as zhEntries, audioFor } from '../sources/wiktionary-zh.js';
import { entries as genericEntries } from '../sources/wiktionary.js';
import { entries as cedictEntries } from '../sources/cedict-text.js';
import { FIXTURE as CEDICT_FIXTURE } from './helpers.js';

const fixture = (code) => resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures', `wiktionary-${code}.jsonl`);
async function all(source, path) {
  const out = [];
  for await (const e of source(path)) out.push(e);
  return out;
}

test('Chinese: Mandarin recordings of the reading, at most two', async () => {
  const rows = await all(zhEntries, fixture('zh'));
  const audio = (trad, pinyin) => rows.find((r) => r.trad === trad && r.pinyin === pinyin).audio;
  assert.deepEqual(audio('馬', 'ma3'), ['zh-mǎ.ogg']);
  assert.deepEqual(audio('了', 'liao3'), ['zh-liǎo.ogg'], 'the file spelling liǎo goes to liao3 only');
  assert.ok(!audio('了', 'le5').includes('zh-liǎo.ogg'));
  assert.deepEqual(audio('安心', 'an1 xin1'), ['zh-cmn-安心.opus'], 'the Cantonese recording is left out');
  assert.ok(rows.every((r) => r.audio.length <= 2));
  assert.deepEqual(audioFor({ sounds: [{ audio: 'yue-a.ogg', tags: ['Cantonese'] }] }, ''), ['yue-a.ogg'], 'no Mandarin reading: any recording');
  assert.deepEqual(audioFor({ sounds: [{ audio: 'yue-a.ogg', tags: ['Cantonese'] }] }, 'a1'), []);
});

test('other languages: the first two recordings of the record', async () => {
  const en = await all(genericEntries, fixture('en'));
  assert.deepEqual(en.find((r) => r.simp === 'house').audio, ['en-us-house-noun.ogg', 'En-uk-house.ogg']);
  const ru = await all(genericEntries, fixture('ru'));
  assert.deepEqual(ru.find((r) => r.simp === 'Москва').audio, ['Ru-Москва.ogg']);
  const pl = await all(genericEntries, fixture('pl'));
  assert.ok(pl.every((r) => Array.isArray(r.audio)));
});

test('index: audio names round-trip in a shared name table, entries without get []', async () => {
  const list = [
    { simp: '馬', pinyin: 'ma3', definition: 'horse', audio: ['zh-mǎ.ogg'] },
    { simp: '码', pinyin: 'ma3', definition: 'code' },
    { simp: '馬上', pinyin: 'ma3 shang4', definition: 'at once', audio: ['zh-mǎshàng.ogg', 'zh-mǎ.ogg'] },
  ];
  const bytes = serializeIndex(await buildIndex(list));
  const { sections } = deserializeIndexWithHeader(bytes);
  assert.deepEqual([...sections.audioEntries], [0, 2]);
  assert.equal(sections.audioNameOffsets.length, 3, 'two unique names');
  const d = openIndex(bytes);
  assert.deepEqual(d.entry(0).audio, ['zh-mǎ.ogg']);
  assert.deepEqual(d.entry(1).audio, []);
  assert.deepEqual(d.entry(2).audio, ['zh-mǎshàng.ogg', 'zh-mǎ.ogg']);
  assert.deepEqual(d.search('mashang')[0].audio, ['zh-mǎshàng.ogg', 'zh-mǎ.ogg']);
  assert.equal(AUDIO_URL_PREFIX + encodeURIComponent('zh-mǎ.ogg'), 'https://commons.wikimedia.org/wiki/Special:FilePath/zh-m%C7%8E.ogg');
});

test('index without audio: no sections, every entry []', async () => {
  const bytes = serializeIndex(await buildIndex(cedictEntries(CEDICT_FIXTURE)));
  assert.equal(deserializeIndexWithHeader(bytes).sections.audioEntries, undefined);
  assert.deepEqual(openIndex(bytes).search('nihao')[0].audio, []);
});
