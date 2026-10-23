import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseLanguageList, parseDates, LANGUAGES_JSON } from '../scripts/kaikki-languages.js';

const PAGE = `<ul><li><a href="All%20languages%20combined/index.html">All languages combined (13116893 senses)</a></li>
<li><a href="English/index.html">English (1787236 senses)</a></li>
<li><a href="K%27iche%27/index.html">K&#x27;iche&#x27; (505 senses)</a></li></ul>
<p>This dictionary is based on structured data extracted on 2026-10-03 from the enwiktionary dump dated 2026-09-02 using wiktextract</p>`;

test('language list page: names, pages and sense counts, without the combined file', () => {
  assert.deepEqual(parseLanguageList(PAGE), [
    { name: 'English', page: 'https://kaikki.org/dictionary/English/index.html', senses: 1787236 },
    { name: "K'iche'", page: 'https://kaikki.org/dictionary/K%27iche%27/index.html', senses: 505 },
  ]);
  assert.deepEqual(parseDates(PAGE), { extracted: '2026-10-03', dumpDate: '2026-09-02' });
});

test('data/languages.json lists every language once with a code and a download', () => {
  const list = JSON.parse(readFileSync(LANGUAGES_JSON, 'utf8'));
  assert.match(list.dumpDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(list.languages.length > 400);
  assert.equal(new Set(list.languages.map((l) => l.code)).size, list.languages.length);
  for (const l of list.languages) {
    assert.match(l.code, /^[a-z0-9-]+$/, l.name);
    assert.match(l.url, /^https:\/\/kaikki\.org\/dictionary\/.+\.jsonl$/, l.name);
    assert.ok(l.bytes > 0 && l.senses > 0, l.name);
  }
  const byCode = Object.fromEntries(list.languages.map((l) => [l.code, l.name]));
  assert.deepEqual([byCode.zh, byCode.en, byCode.de, byCode.ja, byCode.pl], ['Chinese', 'English', 'German', 'Japanese', 'Polish']);
});
