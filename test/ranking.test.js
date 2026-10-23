import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { buildIndex } from '../build-index.js';
import { serializeIndex } from '../lib/index-format.js';
import { openIndex, loadIndex } from '../lookup.js';

// Ranking of ASCII queries on a Chinese index: English glosses, pinyin
// syllables, pinyin prefixes and English prefixes merged by score.
const ENTRIES = [
  { simp: '屎', pinyin: 'shi3', definition: '(character) excrement; poop/(Cantonese) shitty; bad' },
  { simp: '拉屎', pinyin: 'la1 shi3', definition: '(verb) (informal) to crap; to shit; to defecate' },
  { simp: '狗屎', pinyin: 'gou3 shi3', definition: '(noun) (literally) dog faeces; dog shit' },
  { simp: '谢特', pinyin: 'xie4 te4', definition: '(noun) (Internet slang) shit' },
  { simp: '实体', pinyin: 'shi2 ti3', definition: '(noun) entity; substance' },
  { simp: '石头', pinyin: 'shi2 tou5', definition: '(noun) stone; rock' },
  { simp: '十', pinyin: 'shi2', definition: '(character) ten' },
  { simp: '是', pinyin: 'shi4', definition: '(character) to be; yes' },
  { simp: '施', pinyin: 'Shi1', definition: '(character) to grant; to give/(surname) Shi' },
  { simp: '史', pinyin: 'shi3', definition: '(character) history/a surname, Shi' },
  { simp: '半', pinyin: 'ban4', definition: '(character) half; semi-' },
  { simp: '班', pinyin: 'ban1', definition: '(character) class; team; shift' },
  { simp: '办法', pinyin: 'ban4 fa3', definition: '(noun) method; way; means' },
  { simp: '禁止', pinyin: 'jin4 zhi3', definition: '(verb) to prohibit; to ban; to forbid' },
  { simp: '禁令', pinyin: 'jin4 ling4', definition: '(noun) (law) prohibition; ban' },
  { simp: '封禁', pinyin: 'feng1 jin4', definition: '(verb) to close down/to ban (an account)' },
  { simp: '取缔', pinyin: 'qu3 di4', definition: '(verb) to outlaw (publications, bans, etc.)' },
  { simp: '人', pinyin: 'ren2', definition: '(character) man; person; people' },
  { simp: '男人', pinyin: 'nan2 ren2', definition: '(noun) man/(adj) (colloquial) manly' },
  { simp: '满', pinyin: 'man3', definition: '(character) full; filled' },
  { simp: '慢', pinyin: 'man4', definition: '(character) slow' },
  { simp: '满意', pinyin: 'man3 yi4', definition: '(adj) satisfied; pleased' },
  { simp: '冰淇淋', pinyin: 'bing1 qi2 lin2', definition: '(noun) ice cream' },
  { simp: '冰', pinyin: 'bing1', definition: '(character) ice/(medicine) cream for burns' },
];

async function fixture() {
  return openIndex(serializeIndex(await buildIndex(ENTRIES.map((e) => ({ trad: e.simp, ...e })))));
}

const simps = (rows) => rows.map((r) => r.simp);
const WHOLE_WORD = (w) => new RegExp(`(?<![\\p{L}\\p{N}])${w}(?![\\p{L}\\p{N}])`, 'u');

describe('merged ranking of ASCII queries (fixture)', async () => {
  const d = await fixture();

  test('an English word ranks above pinyin prefixes of the same letters', () => {
    const rows = d.search('shit', { limit: 50 });
    const firstPinyin = rows.findIndex((r) => r.matchedOn === 'pinyinBare');
    assert.ok(firstPinyin > 0, simps(rows).join(' '));
    for (const r of rows.slice(0, firstPinyin)) assert.equal(r.matchedOn, 'definition');
    assert.deepEqual(new Set(simps(rows.slice(0, 2))), new Set(['谢特', '拉屎']), 'a gloss equal to the query ("shit", "to shit") first');
    assert.equal(rows[2].simp, '狗屎', 'then the word inside a gloss ("dog shit")');
    assert.equal(rows[3].simp, '屎', 'then an inflected form ("shitty")');
    assert.deepEqual(new Set(simps(rows.slice(firstPinyin))), new Set(['实体', '石头']));
  });

  test('a pinyin syllable ranks first when no gloss is that word', () => {
    const rows = d.search('shi', { limit: 50 });
    assert.deepEqual(new Set(simps(rows.slice(0, 5))), new Set(['十', '是', '施', '史', '屎']));
    assert.ok(rows.slice(0, 5).every((r) => r.matchedOn === 'pinyinBare'));
    assert.deepEqual(new Set(simps(rows.slice(5, 7))), new Set(['实体', '石头']), 'pinyin prefixes next');
    assert.ok(rows.slice(7).every((r) => r.matchedOn === 'definition'), 'English prefixes (shit, shift) last');
    const english = d.search('/shi', { limit: 50 });
    assert.deepEqual(new Set(simps(english.slice(0, 2))), new Set(['施', '史']), 'the name "Shi" as a whole word');
    assert.ok(english.length > 2, 'then English words starting with "shi"');
  });

  test('tone digits, u: and explicit pinyin mode search pinyin only', () => {
    assert.deepEqual(simps(d.search('shi4')), ['是']);
    const spaced = d.search('shi t', { limit: 50 });
    assert.deepEqual(new Set(simps(spaced.slice(0, 2))), new Set(['实体', '石头']));
    assert.deepEqual(simps(spaced.slice(0, 2)), simps(d.search('p:shi t')), 'pinyin first, as in pinyin-only mode');
    for (const q of ['p:ban', ':ban', 'p: ban']) {
      const rows = d.search(q);
      assert.ok(rows.length > 0 && rows.every((r) => r.matchedOn === 'pinyinBare'), q);
      assert.deepEqual(simps(rows.slice(0, 2)), ['半', '班'], q);
    }
    const session = d.newSession();
    session.search('p:ban');
    assert.equal(session.lastStats.mode, 'pinyin');
  });

  test('English only with a leading slash', () => {
    const rows = d.search('/ban');
    assert.ok(rows.every((r) => r.matchedOn === 'definition'));
    assert.deepEqual(simps(rows), ['禁止', '封禁', '禁令', '取缔']);
  });

  test('gloss order: unrestricted before restricted, earlier sense before later', () => {
    // 禁止 has "ban" unqualified in its first sense, 封禁 in its second,
    // 禁令 in a sense labelled "(law)"; 取缔 has only "bans".
    assert.deepEqual(simps(d.search('ban').slice(0, 2)), ['禁止', '封禁']);
    const rows = d.search('ban', { limit: 50 });
    const at = (s) => rows.findIndex((r) => r.simp === s);
    assert.ok(at('封禁') < at('半') && at('半') < at('禁令') && at('禁令') < at('办法'),
      'gloss > pinyin syllable > restricted gloss > pinyin prefix');
    assert.deepEqual(simps(d.search('/ban')), ['禁止', '封禁', '禁令', '取缔'], 'English only: the restricted gloss is the last gloss');
  });

  test('English word, then pinyin syllable, then pinyin prefix, then English prefix', () => {
    const rows = d.search('man', { limit: 50 });
    assert.deepEqual(simps(rows), ['人', '男人', '满', '慢', '满意']);
    assert.deepEqual(rows.map((r) => r.matchedOn), ['definition', 'definition', 'pinyinBare', 'pinyinBare', 'pinyinBare']);
    const prefix = d.search('manl', { limit: 50 });
    assert.deepEqual(simps(prefix), ['男人'], '"manly" by English prefix');
  });

  test('a phrase query matches a gloss of several words', () => {
    assert.equal(d.search('ice cream')[0].simp, '冰淇淋');
    assert.equal(d.search('/ice cream')[0].simp, '冰淇淋');
  });

  test('typing and backspacing narrow both ranges and match a fresh session', () => {
    const seqs = [['s', 'sh', 'shi', 'shit', 'shi', 'sh'], ['m', 'ma', 'man', 'mann', 'man'], ['i', 'ic', 'ice', 'ice c', 'ice cream']];
    for (const seq of seqs) {
      const session = d.newSession();
      for (const q of seq) {
        assert.deepEqual(simps(session.search(q, { limit: 50 })), simps(d.newSession().search(q, { limit: 50 })), `${seq} at ${q}`);
      }
    }
    const session = d.newSession();
    session.search('sh');
    session.search('shi');
    const fresh = d.newSession();
    fresh.search('shit');
    session.search('shit');
    assert.ok(session.lastStats.searched < fresh.lastStats.searched, `${session.lastStats.searched} < ${fresh.lastStats.searched}`);
    session.search('shi');
    assert.equal(session.lastStats.bisects, 0, 'backspace reuses the pinyin, word and gloss ranges');
  });

  test('a one-letter query is not an English word', () => {
    assert.ok(d.search('s', { limit: 50 }).slice(0, 5).every((r) => r.matchedOn === 'pinyinBare'));
  });
});

const ZH_INDEX = process.env.WIKTIONARY_ZH_INDEX ?? '/mnt/biglinks/wiktionary/wiktionary-zh.idx';

describe('merged ranking on the Wiktionary Chinese index', { skip: !existsSync(ZH_INDEX) && `${ZH_INDEX} not built` }, async () => {
  const d = existsSync(ZH_INDEX) ? await loadIndex(ZH_INDEX) : null;
  const hasGlossTable = d && Boolean(d.keys.glosses);

  test('"shit": every entry with the whole word "shit" before any pinyin prefix hit', { skip: !hasGlossTable && 'index without gloss table' }, () => {
    const rows = d.search('shit', { limit: 200 });
    const firstPinyin = rows.findIndex((r) => r.matchedOn !== 'definition');
    assert.ok(firstPinyin >= 20, `first pinyin hit at ${firstPinyin}`);
    const before = rows.slice(0, firstPinyin);
    for (const s of ['拉屎', '狗屎', '吃屎']) assert.ok(before.some((r) => r.simp === s), s);
    for (const r of rows.slice(firstPinyin)) assert.doesNotMatch(r.definition, /(?<![\p{L}\p{N}])shit(?![\p{L}\p{N}])/u, r.simp);
    assert.ok(before.some((r) => r.simp === '屎'), '屎 via "shitty"');
  });

  test('"shi" and "dang" still list pinyin syllables first', () => {
    for (const q of ['shi', 'dang', 'shi t', 'shi4', 'nihao', 'zhongguo']) {
      const rows = d.search(q, { limit: 20 });
      assert.ok(rows.slice(0, 10).every((r) => r.matchedOn.startsWith('pinyin')), `${q}: ${simps(rows).join(' ')}`);
    }
    assert.ok(d.search('shi', { limit: 50 }).every((r) => r.pinyin.toLowerCase().replace(/[0-9 ]/g, '') === 'shi'), 'exact syllable first');
  });

  test('English words that are also pinyin syllables list English first', { skip: !hasGlossTable && 'index without gloss table' }, () => {
    const expected = { ban: '禁令', man: '男人', shun: '回避', lie: '谎言' };
    for (const [q, word] of Object.entries(expected)) {
      const rows = d.search(q, { limit: 50 });
      assert.equal(rows[0].matchedOn, 'definition', q);
      assert.match(rows[0].definition, WHOLE_WORD(q), q);
      assert.ok(simps(rows.slice(0, 30)).includes(word), `${q} -> ${word}: ${simps(rows).join(' ')}`);
      const all = d.search(q, { limit: 5000 });
      const firstPinyin = all.findIndex((r) => r.matchedOn === 'pinyinBare');
      assert.ok(firstPinyin > 0, `${q}: pinyin from ${firstPinyin}`);
    }
    assert.equal(d.search('man')[0].simp, '人');
  });
});
