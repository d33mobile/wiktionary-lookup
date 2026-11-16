import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { editDistance, leadingDeletions } from '../lib/fuzzy.js';
import { partitionPoint } from '../lib/bisect.js';
import { buildIndex } from '../build-index.js';
import { serializeIndex } from '../lib/index-format.js';
import { openIndex } from '../lib/engine.js';
import { entries as genericEntries } from '../sources/wiktionary.js';
import { entries as zhEntries } from '../sources/wiktionary-zh.js';
import { loadIndex, openIndexLazy, nodeFileReader } from '../lookup.js';

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const EN_INDEX = process.env.WIKTIONARY_EN_INDEX || '/mnt/biglinks/wiktionary/idx/en.idx';
const dir = mkdtempSync(join(tmpdir(), 'fuzzy-'));
after(() => rmSync(dir, { recursive: true, force: true }));

async function fixtureBytes(code) {
  const info = {};
  const source = code === 'zh' ? zhEntries : genericEntries;
  const sections = await buildIndex(source(join(FIXTURES, `wiktionary-${code}.jsonl`), info), info);
  return serializeIndex(sections, info);
}

const heads = (rows) => rows.map((r) => r.simp);

// Plain dynamic programming without cutoff, as the reference.
function reference(a, b) {
  const s = Array.from(a);
  const t = Array.from(b);
  const d = Array.from({ length: s.length + 1 }, (_, i) => Array.from({ length: t.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= s.length; i++) {
    for (let j = 1; j <= t.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (s[i - 1] === t[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && s[i - 1] === t[j - 2] && s[i - 2] === t[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[s.length][t.length];
}

test('editDistance: insertions, deletions, substitutions, transpositions', () => {
  assert.equal(editDistance('howitzer', 'howitzer'), 0);
  assert.equal(editDistance('howizer', 'howitzer'), 1, 'one letter missing');
  assert.equal(editDistance('howitzr', 'howitzer'), 1);
  assert.equal(editDistance('hwoitzer', 'howitzer'), 1, 'adjacent letters swapped');
  assert.equal(editDistance('ingenoius', 'ingenious'), 1);
  assert.equal(editDistance('ingenous', 'ingenious'), 1);
  assert.equal(editDistance('ingenoius', 'ingenius'), 1, 'or drop the o');
  assert.equal(editDistance('kitten', 'sitting'), 3);
  assert.equal(editDistance('ca', 'abc'), 3, 'restricted form: no edit of a transposed pair');
  assert.equal(editDistance('', 'abc'), 3);
  assert.equal(editDistance('abc', ''), 3);
});

test('editDistance counts code points', () => {
  assert.equal(editDistance('你好', '你号'), 1);
  assert.equal(editDistance('a𝒳b', 'ab'), 1, 'an astral character is one');
  assert.equal(editDistance('żółw', 'zółw'), 1);
});

test('editDistance stops at max and returns max + 1 beyond it', () => {
  assert.equal(editDistance('kitten', 'sitting', 2), 3);
  assert.equal(editDistance('kitten', 'sitting', 3), 3);
  assert.equal(editDistance('abc', 'abcdefg', 2), 3, 'length difference alone');
  assert.equal(editDistance('howizer', 'hamburger', 2), 3);
  assert.equal(editDistance('howizer', 'howitzer', 1), 1);
  assert.equal(editDistance('abcd', 'badc', 1), 2, 'two transpositions');
  assert.equal(editDistance('abcd', 'badc', 2), 2);
});

test('editDistance with a cutoff agrees with the plain computation', () => {
  const words = ['howitzer', 'howizer', 'hwoitzer', 'howitzr', 'how', 'however', 'whoa', 'ab', 'ba', 'abc', 'acb', 'bca',
    'ingenious', 'ingenius', 'ingenoius', 'nihao', 'nihoa', 'inhao', 'ni', '', 'a', 'aa', 'aab', 'aba', 'baa'];
  for (const a of words) {
    for (const b of words) {
      const full = reference(a, b);
      assert.equal(editDistance(a, b), full, `${a} / ${b}`);
      for (const max of [0, 1, 2, 3]) {
        assert.equal(editDistance(a, b, max), Math.min(full, max + 1), `${a} / ${b} max ${max}`);
      }
    }
  }
});

test('leadingDeletions drops one of the first letters', () => {
  assert.deepEqual(leadingDeletions('gowitzer', 3), ['owitzer', 'gwitzer', 'goitzer']);
  assert.deepEqual(leadingDeletions('aab', 3), ['ab', 'aa']);
  assert.deepEqual(leadingDeletions('ab', 3), ['b', 'a']);
  assert.deepEqual(leadingDeletions('', 3), []);
});

test('partitionPoint finds the same bounds as a bisect, also with unreadable keys', () => {
  const keys = ['a', 'ab', 'ab', 'abc', 'abd', 'b', 'ba', 'bb', 'c', 'ca', 'cab', 'cb', 'd'];
  const keyAt = (i) => keys[i];
  for (const p of ['', 'a', 'ab', 'abc', 'b', 'bz', 'c', 'ca', 'd', 'e', '0']) {
    const lower = keys.findIndex((k) => k >= p);
    const end = keys.findIndex((k) => !(k < p || k.startsWith(p)));
    for (const fanout of [2, 3, 4, 8, 16, 64]) {
      assert.equal(partitionPoint(0, keys.length, keyAt, (k) => k < p, fanout), lower < 0 ? keys.length : lower, `${p} lower ${fanout}`);
      assert.equal(partitionPoint(0, keys.length, keyAt, (k) => k < p || k.startsWith(p), fanout), end < 0 ? keys.length : end, `${p} end ${fanout}`);
      // Keys become readable only once asked for: every call asks for at
      // least one new key until the answer comes.
      const loaded = new Set();
      const asked = new Set();
      const lazyAt = (i) => {
        asked.add(i);
        return loaded.has(i) ? keys[i] : null;
      };
      let result = -1;
      let rounds = 0;
      while ((result = partitionPoint(0, keys.length, lazyAt, (k) => k < p, fanout)) < 0) {
        const before = loaded.size;
        for (const i of asked) loaded.add(i);
        assert.ok(loaded.size > before, 'progress');
        rounds++;
      }
      assert.equal(result, lower < 0 ? keys.length : lower);
      assert.ok(rounds <= Math.ceil(Math.log(keys.length + 1) / Math.log(fanout)) + 1, `${rounds} rounds at fanout ${fanout}`);
    }
  }
});

describe('fuzzy fallback on the Wiktionary fixtures', async () => {
  const en = openIndex(await fixtureBytes('en'));
  const de = openIndex(await fixtureBytes('de'));
  const zh = openIndex(await fixtureBytes('zh'));

  test('a letter left out, swapped or doubled finds the word', () => {
    for (const q of ['ingenous', 'ingenoius', 'ingeniuos', 'ingeniious']) {
      const rows = en.search(q);
      assert.equal(rows[0].simp, 'ingenious', q);
      assert.equal(rows[0].fuzzy, 1, q);
      assert.equal(rows[0].matchedOn, 'simp', q);
      assert.ok(rows.every((r) => r.fuzzy >= 1 && r.fuzzy <= 2), `${q}: only fuzzy results`);
    }
    assert.deepEqual(en.defaultSession.lastStats.fuzzy, { scanned: 2, found: 2 });
  });

  test('an extra first letter is found through a leading deletion', () => {
    for (const q of ['xingenious', 'ixngenious', 'inxgenious']) {
      assert.equal(en.search(q)[0].simp, 'ingenious', q);
    }
  });

  test('two edits only for queries longer than four characters', () => {
    assert.deepEqual(en.search('ingenxx'), [], 'three edits from ingenius');
    assert.equal(en.search('ingexios')[0].fuzzy, 2);
    assert.deepEqual(heads(de.search('Hasu')), ['Haus']);
    assert.deepEqual(heads(de.search('Haxy')), [], 'two edits on a four-letter query');
  });

  test('German: a wrong letter, case and diacritics folded', () => {
    const rows = de.search('Strase');
    assert.equal(rows[0].simp, 'Straße');
    assert.equal(rows[0].fuzzy, 1);
    assert.equal(de.search('strasse')[0].simp, 'Straße');
  });

  test('Chinese: a pinyin typo, not a tone digit or characters', () => {
    for (const q of ['nihoa', 'p:nihoa', 'ni hoa', 'nhiao']) {
      const rows = zh.search(q);
      assert.equal(rows[0].simp, '你好', q);
      assert.equal(rows[0].matchedOn, 'pinyinBare', q);
      assert.equal(rows[0].fuzzy, 1, q);
    }
    assert.deepEqual(zh.search('ni3hoa3'), [], 'a toned query is exact');
    assert.deepEqual(zh.search('你号'), [], 'no fuzzy search over characters');
  });

  test('nothing fuzzy when the normal search finds anything', () => {
    for (const q of ['ing', 'ingen', 'ingenious', 'house']) {
      const rows = en.search(q);
      assert.ok(rows.length > 0, q);
      assert.ok(rows.every((r) => r.fuzzy === undefined), q);
      assert.equal(en.defaultSession.lastStats.fuzzy, undefined, q);
    }
    assert.ok(zh.search('nihao').every((r) => r.fuzzy === undefined));
  });

  test('nothing for queries under three characters, nor in definition mode', () => {
    for (const q of ['ix', 'ig', 'ni']) {
      assert.deepEqual(en.search(q).filter((r) => r.fuzzy), [], q);
    }
    assert.equal(en.search('ix').length, 0);
    assert.equal(en.defaultSession.lastStats.fuzzy, undefined);
    assert.deepEqual(en.search('/ingenous'), [], '"/" searches definitions only');
  });

  test('a lazily opened index with a tiny cache finds the same', async () => {
    for (const code of ['en', 'de', 'zh']) {
      const file = join(dir, `${code}.idx`);
      writeFileSync(file, await fixtureBytes(code));
      const eager = openIndex(readFileSync(file));
      const lazy = await openIndexLazy(await nodeFileReader(file), {
        residentBytes: 0, cache: { blockBytes: 256, maxBytes: 4096, spanBytes: 1024 },
      });
      for (const q of ['ingenous', 'xingenious', 'ingexios', 'Strase', 'Hasu', 'nihoa', 'p:nihoa', 'nhiao', 'zzzzz']) {
        assert.deepEqual(await lazy.newSession().searchAsync(q), eager.search(q), `${code} ${q}`);
      }
      await lazy.close();
    }
  });
});

describe('fuzzy fallback on the real English index', { skip: !existsSync(EN_INDEX) && `no ${EN_INDEX}` }, () => {
  const QUERIES = { howizer: 'howitzer', howitzr: 'howitzer', hjowitzer: 'howitzer', ingenous: 'ingenious', acommodate: 'accommodate' };

  test('in memory', async () => {
    const d = await loadIndex(EN_INDEX, { details: false });
    for (const [q, word] of Object.entries(QUERIES)) {
      const rows = d.search(q);
      assert.equal(rows[0].simp, word, q);
      assert.equal(rows[0].fuzzy, 1, q);
    }
  });

  test('opened lazily: the same results, in a few more rounds of reads', async (t) => {
    const d = await loadIndex(EN_INDEX, { details: false });
    const expected = Object.fromEntries(Object.keys(QUERIES).map((q) => [q, d.search(q)]));
    // Rounds of Dictionary.retry: one load (or one batch, needAll) each.
    let rounds = 0;
    const retry = async (fn) => {
      for (;;) {
        try {
          return fn();
        } catch (err) {
          rounds++;
          if (err.ranges) await lazy.blockCache.loadAll(err.ranges);
          else await lazy.blockCache.load(err.offset, err.length);
        }
      }
    };
    let lazy = null;
    for (const q of Object.keys(QUERIES)) {
      // A fresh open per query: nothing cached from the one before.
      lazy = await openIndexLazy(await nodeFileReader(EN_INDEX));
      rounds = 0;
      const session = lazy.newSession();
      await retry(() => session.candidates(q, { rangesOnly: true }));
      const ranges = rounds;
      const found = await retry(() => session.candidates(q));
      assert.deepEqual(await lazy.entriesAsync(found), expected[q], q);
      t.diagnostic(`${q}: ${ranges} rounds for the key ranges, ${rounds - ranges} for the candidates with the fuzzy fallback`);
      assert.ok(rounds - ranges <= 30, `${q}: ${rounds - ranges} rounds`);
      await lazy.close();
    }
  });
});
