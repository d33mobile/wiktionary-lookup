import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadIndex } from '../lookup.js';
import { codePointLength } from '../lib/normalize.js';
import { fixtureDictionary, fullIndexAvailable, FULL_INDEX, ids } from './helpers.js';

const SEQUENCES = [
  ['n', 'ni', 'nih', 'niha', 'nihao'],
  ['nihao', 'niha', 'nih', 'ni', 'n', 'ni', 'nian'],
  ['z', 'zh', 'zho', 'zhong', 'zhong1', 'zhong1g', 'zhong'],
  ['中', '中国', '中国人', '中国', '中'],
  ['/h', '/he', '/hel', '/hello', '/hel', '/hello wor'],
  ['n', 'ni', '中', '中国', 'ni', 'nih'],
];

function suite(name, open) {
  describe(name, async () => {
    const d = await open();

    test('incremental narrowing returns what a fresh search returns', () => {
      for (const seq of SEQUENCES) {
        const session = d.newSession();
        for (const q of seq) {
          const incremental = ids(session.search(q, { limit: 50 }));
          const fresh = ids(d.newSession().search(q, { limit: 50 }));
          assert.deepEqual(incremental, fresh, `sequence ${seq.join(' > ')} at "${q}"`);
        }
      }
    });

    test('extending the query bisects inside the previous range', () => {
      const session = d.newSession();
      session.search('ni');
      const wide = session.lastStats.searched;
      session.search('nih');
      assert.ok(session.lastStats.searched < wide, `${session.lastStats.searched} < ${wide}`);
      session.search('ni');
      assert.equal(session.lastStats.bisects, 0, 'backspace reuses the stored range');
    });

    test('pinyin is tone- and space-insensitive', () => {
      for (const q of ['nihao', 'ni hao', 'NiHao', 'ni3hao3', 'ni3 hao3', 'Ni3 Hao3', 'ni3hao']) {
        const rows = d.search(q);
        assert.equal(rows[0]?.simp, '你好', q);
      }
      assert.equal(d.search('ni3hao3')[0].matchedOn, 'pinyinToned');
      assert.equal(d.search('nihao')[0].matchedOn, 'pinyinBare');
      assert.equal(d.search('ni4hao3').length, 0, 'wrong tone does not match');
    });

    test('u-umlaut can be typed as v, u: or the letter itself', () => {
      for (const q of ['lv', 'lu:', 'lü', 'lv4', 'lü4', 'LV', 'lvse', 'lü4 se4']) {
        const rows = d.search(q);
        assert.ok(rows.length > 0, q);
        for (const r of rows) assert.match(r.pinyin.toLowerCase(), /^lü[1-5]/, `${q} -> ${r.pinyin}`);
      }
      assert.equal(d.search('lvse')[0].simp, '绿色');
    });

    test('CJK prefix search over simplified and traditional headwords', () => {
      const rows = d.search('中');
      assert.ok(rows.length > 0);
      for (const r of rows) assert.ok(r.simp.startsWith('中') || r.trad.startsWith('中'), r.simp);
      assert.equal(rows[0].simp, '中', 'exact match first');
      const zhongguo = d.search('中国');
      assert.equal(zhongguo[0].simp, '中国');
      assert.equal(zhongguo[0].matchedOn, 'simp');
      const tradOnly = d.search('中國');
      assert.equal(tradOnly[0].simp, '中国');
      assert.equal(tradOnly[0].matchedOn, 'trad');
    });

    test('ranking: exact before prefix, shorter headword before longer', () => {
      const rows = d.search('zhong');
      const lengths = rows.map((r) => codePointLength(r.simp));
      assert.deepEqual(lengths, [...lengths].sort((a, b) => a - b));
      const zh = d.search('中', { limit: 50 });
      const exact = zh.filter((r) => r.simp === '中' || r.trad === '中').length;
      assert.ok(zh.slice(0, exact).every((r) => r.simp === '中' || r.trad === '中'));
    });

    test('definition words: explicit /query and fallback from pinyin', () => {
      assert.ok(d.search('/hello').some((r) => r.simp === '你好'));
      assert.equal(d.search('hello')[0].matchedOn, 'definition');
      assert.ok(d.search('/emergency number').every((r) => /emergency number/.test(r.definition)));
      assert.ok(d.search('/emergency number').length > 0);
    });

    test('limit is respected and entries are not duplicated', () => {
      const rows = d.search('中', { limit: 3 });
      assert.equal(rows.length, 3);
      const all = d.search('中', { limit: 1000 });
      assert.equal(new Set(ids(all)).size, all.length);
    });

    test('empty or blank query returns nothing', () => {
      assert.deepEqual(d.search(''), []);
      assert.deepEqual(d.search('   '), []);
      assert.deepEqual(d.search('/'), []);
    });

    test('non-ASCII and odd input does not throw', () => {
      const biang = d.search('𰻝');
      assert.ok(biang.length > 0, 'non-BMP headword');
      assert.ok(biang.some((r) => r.simp === '𰻝𰻝面'));
      assert.ok(biang.every((r) => r.simp.startsWith('𰻝')));
      for (const q of ['nǐ hǎo', '😀', '中a', 'a中', '\u0000', '///', '中\uD800', 'ni3hao3!!!', 'Ü']) {
        assert.ok(Array.isArray(d.search(q)), q);
      }
      assert.deepEqual(d.search('😀'), []);
      assert.deepEqual(d.search('中a'), []);
    });
  });
}

suite('fixture index', fixtureDictionary);
if (fullIndexAvailable()) suite('full CC-CEDICT index', () => loadIndex(FULL_INDEX));
