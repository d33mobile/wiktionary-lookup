import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildIndex, DETAILS_BLOCK } from '../build-index.js';
import { serializeIndex } from '../lib/index-format.js';
import { openIndex } from '../lookup.js';
import { entries as zhEntries } from '../sources/wiktionary-zh.js';
import { entries as genericEntries } from '../sources/wiktionary.js';
import { recordDetails, etymologyText, MAX_EXAMPLES } from '../sources/wiktionary-details.js';
import { entries as cedictEntries } from '../sources/cedict-text.js';
import { FIXTURE as CEDICT_FIXTURE } from './helpers.js';

const fixture = (code) => resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures', `wiktionary-${code}.jsonl`);
const zlibInflate = (bytes) => gunzipSync(bytes).toString('utf8');

async function open(source, path) {
  const info = {};
  const d = openIndex(serializeIndex(await buildIndex(source(path, info), info), info));
  d.inflate = zlibInflate;
  return d;
}

test('zh: senses with one example of each Traditional/Simplified pair, forms, sounds without the extra systems', async () => {
  const d = await open(zhEntries, fixture('zh'));
  const nihao = await d.getDetails(d.search('nihao')[0].id);
  assert.equal(nihao.title, '你好');
  const [rec] = nihao.records;
  assert.equal(rec.pos, 'intj');
  assert.deepEqual(rec.senses[0].examples[0], { text: '你好，好久不见。', roman: 'Nǐ hǎo, hǎojiǔbùjiàn.', english: 'Hi, long time no see.' });
  assert.ok(rec.sounds.some((s) => s.text === 'nei⁵ hou²' && s.tags.includes('Jyutping')), 'Cantonese reading');
  const xuexi = await d.getDetails(d.search('xuexi')[0].id);
  assert.equal(xuexi.title, '學習', 'page title for the link');
  assert.deepEqual(xuexi.records[0].forms, [{ form: '学习', tags: ['Simplified-Chinese'] }]);
  assert.ok(xuexi.records[0].sounds.every((s) => !s.tags.includes('Wade-Giles') && !s.tags.includes('Palladius')));
  assert.ok(!xuexi.records[0].sounds.some((s) => 'audio' in s), 'recordings stay in the audio field');
});

test('de and ru: examples, inflections with tags, IPA, etymology without the tree', async () => {
  const de = await open(genericEntries, fixture('de'));
  const haus = await de.getDetails(de.search('haus')[0].id);
  assert.equal(haus.title, 'Haus');
  const noun = haus.records.find((r) => r.pos === 'noun');
  assert.equal(noun.senses[0].gloss, 'house, building');
  assert.deepEqual(noun.senses[0].examples[0], { text: 'In dem Haus haben wir mal gewohnt.', english: 'We used to live in that house.' });
  assert.ok(noun.forms.some((f) => f.form === 'Häuser' && f.tags.includes('plural')));
  assert.ok(noun.sounds.some((s) => s.kind === 'ipa' && s.text === '[haʊ̯s]'));
  assert.match(noun.etymology, /^From Middle High German hūs/);
  const ru = await open(genericEntries, fixture('ru'));
  const dom = await ru.getDetails(ru.search('дом')[0].id);
  const ex = dom.records[0].senses[0].examples;
  assert.equal(ex.length, MAX_EXAMPLES);
  assert.deepEqual(ex[0], { text: 'обы́скивать дом за до́мом', roman: 'obýskivatʹ dom za dómom', english: 'to search house by house' });
  assert.ok(dom.records[0].forms.some((f) => f.form === 'до́ма' && f.tags.includes('genitive')));
});

test('record details: caps, relations, examples left out on request', () => {
  const record = {
    word: 'x', pos: 'noun', lang: 'German',
    senses: [{ glosses: ['a gloss'], examples: Array.from({ length: 5 }, (_, i) => ({ text: `e${i}`, translation: `t${i}` })) }],
    synonyms: [{ word: 'y', sense: 'house' }, { word: 'y' }, { word: 'z', roman: 'zz' }],
    etymology_text: 'Etymology tree\nProto-Germanic *x\nGerman x\nFrom Proto-Germanic *x.',
  };
  const d = recordDetails(record);
  assert.equal(d.senses[0].examples.length, MAX_EXAMPLES);
  assert.deepEqual(d.senses[0].examples[0], { text: 'e0', english: 't0' });
  assert.deepEqual(d.synonyms, [{ word: 'y', sense: 'house' }, { word: 'z', roman: 'zz' }]);
  assert.equal(d.etymology, 'From Proto-Germanic *x.');
  assert.equal(etymologyText({ etymology_text: 'plain' }), 'plain');
  assert.equal(recordDetails(record, { examples: false }).senses[0].examples, undefined);
  assert.equal(recordDetails({ word: 'x', pos: 'noun', senses: [] }), null);
});

test('blocks: every entry finds its own details across block boundaries', async () => {
  const n = DETAILS_BLOCK * 2 + 22;
  const list = Array.from({ length: n }, (_, i) => ({
    simp: `w${i}`, pinyin: '', definition: `d${i}`, details: i % 5 === 0 ? null : { title: `w${i}`, i },
  }));
  const info = {};
  const d = openIndex(serializeIndex(await buildIndex(list, info), info));
  d.inflate = zlibInflate;
  assert.deepEqual(info.details.blockSize, DETAILS_BLOCK);
  for (const i of [0, 1, DETAILS_BLOCK - 1, DETAILS_BLOCK, DETAILS_BLOCK + 1, n - 1]) {
    assert.deepEqual(await d.getDetails(i), i % 5 === 0 ? null : { title: `w${i}`, i }, `entry ${i}`);
  }
  assert.equal(await d.getDetails(n), null);
});

test('an index without details returns null and needs no decoder', async () => {
  const d = openIndex(serializeIndex(await buildIndex(cedictEntries(CEDICT_FIXTURE))));
  assert.equal(await d.getDetails(0), null);
});

describe('details sidecar file', async () => {
  const { mkdtemp, readFile } = await import('node:fs/promises');
  const { existsSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { writeIndexFiles, detailsPath, splitDetails } = await import('../build-index.js');
  const { loadIndex, openIndexFile } = await import('../lookup.js');
  const { deserializeIndexWithHeader: read } = await import('../lib/index-format.js');
  const dir = await mkdtemp(join(tmpdir(), 'details-'));
  const build = async () => {
    const info = {};
    const sections = await buildIndex(genericEntries(fixture('de'), info), info);
    return { sections, info };
  };

  test('sidecar mode: index without details sections, x.details beside it', async () => {
    const { sections, info } = await build();
    const out = join(dir, 'de.idx');
    const written = await writeIndexFiles(sections, info, out);
    assert.deepEqual(written.map((w) => w.kind), ['index', 'details']);
    assert.equal(detailsPath(out), join(dir, 'de.details'));
    const base = read(await readFile(out));
    assert.equal(base.sections.detailsData, undefined);
    assert.equal(base.header.details, undefined);
    assert.deepEqual(base.header.language, info.language);
    const side = read(await readFile(detailsPath(out)));
    assert.equal(side.header.kind, 'details');
    assert.equal(side.header.entries, sections.rank.length);
    assert.ok(side.header.details.entries > 0 && side.header.details.entries <= side.header.entries);
    assert.equal(side.sections.fieldOffsets, undefined);
  });

  test('loadIndex finds the sidecar, openIndex and openIndexFile take one, absent -> null', async () => {
    const out = join(dir, 'de.idx');
    for (const d of [await loadIndex(out), openIndexFile(out)]) {
      const haus = await d.getDetails(d.search('haus')[0].id);
      assert.equal(haus.title, 'Haus');
      if (d.close) d.close();
    }
    assert.equal(await (await loadIndex(out, { details: false })).getDetails(0), null);
    const d = openIndex(await readFile(out), { details: await readFile(detailsPath(out)) });
    d.inflate = zlibInflate;
    assert.equal((await d.getDetails(d.search('haus')[0].id)).title, 'Haus');
    const bare = openIndex(await readFile(out));
    assert.equal(await bare.getDetails(0), null, 'no sidecar: null, no decoder needed');
  });

  test('embedded and none modes; a sidecar of another index is refused', async () => {
    const { sections, info } = await build();
    const embedded = join(dir, 'emb.idx');
    assert.deepEqual((await writeIndexFiles(sections, info, embedded, 'embedded')).map((w) => w.kind), ['index']);
    assert.ok(!existsSync(detailsPath(embedded)));
    const d = await loadIndex(embedded);
    assert.equal((await d.getDetails(d.search('haus')[0].id)).title, 'Haus', 'embedded details still read');
    const split = splitDetails(sections, info);
    assert.equal(split.details.meta.entries, sections.rank.length);
    const other = openIndex(serializeIndex(await buildIndex(cedictEntries(CEDICT_FIXTURE))));
    assert.throws(() => other.attachDetails(split.details.sections, split.details.meta), /details file for/);
    const noneInfo = {};
    const none = await buildIndex(genericEntries(fixture('de'), noneInfo, { details: false }), noneInfo);
    assert.deepEqual((await writeIndexFiles(none, noneInfo, join(dir, 'none.idx'), 'sidecar')).map((w) => w.kind), ['index']);
  });
});
