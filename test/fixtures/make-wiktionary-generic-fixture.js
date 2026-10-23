#!/usr/bin/env node
// Regenerates wiktionary-<code>.jsonl for the generic Wiktionary source from
// kaikki.org per-language extracts (scripts/kaikki-languages.js download):
//   node test/fixtures/make-wiktionary-generic-fixture.js /mnt/biglinks/wiktionary/kaikki
// Keeps the records of WORDS[code], reduced to the fields
// sources/wiktionary.js reads.
import { createReadStream, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';

const WORDS = {
  en: ['house', 'shit', 'tea', 'New York', 'café', 'tee'],
  de: ['Haus', 'Häuser', 'groß', 'Straße', 'Tee'],
  ja: ['猫', '食べる', '東京', 'お茶', 'ネコ'],
  ru: ['дом', 'дома', 'Москва', 'чай', 'ёж'],
  pl: ['dom', 'żółw', 'herbata', 'łódź', 'Łódź'],
};
const MAX_SENSES = 3;
const MAX_FORMS = 6;
const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => k in obj).map((k) => [k, obj[k]]));

for (const [code, words] of Object.entries(WORDS)) {
  const wanted = new Set(words);
  const out = [];
  const rl = createInterface({ input: createReadStream(join(process.argv[2], `${code}.jsonl`), 'utf8'), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.includes('"word": "')) continue;
    const d = JSON.parse(line);
    if (!wanted.has(d.word)) continue;
    const r = pick(d, ['word', 'lang', 'lang_code', 'pos']);
    // Romanization, canonical and hangeul forms first, then a few others.
    const forms = d.forms ?? [];
    const key = (f) => ['romanization', 'canonical', 'hangeul'].some((t) => (f.tags ?? []).includes(t));
    r.forms = [...forms.filter(key), ...forms.filter((f) => !key(f)).slice(0, MAX_FORMS)].map((f) => pick(f, ['form', 'tags', 'ruby']));
    r.sounds = (d.sounds ?? []).filter((s) => 'other' in s || 'audio' in s || 'ipa' in s).slice(0, 8)
      .map((s) => pick(s, ['other', 'audio', 'ipa', 'tags']));
    r.senses = (d.senses ?? []).slice(0, MAX_SENSES).map((s) => ({
      ...pick(s, ['glosses', 'raw_glosses', 'tags']),
      ...(s.examples ? { examples: s.examples.slice(0, 4).map((x) => pick(x, ['text', 'roman', 'english', 'translation', 'type'])) } : {}),
    }));
    if (d.etymology_text) r.etymology_text = d.etymology_text;
    for (const rel of ['synonyms', 'antonyms', 'related', 'derived']) {
      if (d[rel]) r[rel] = d[rel].slice(0, 6).map((x) => pick(x, ['word', 'roman', 'english', 'sense']));
    }
    out.push(JSON.stringify(r));
  }
  writeFileSync(join(import.meta.dirname, `wiktionary-${code}.jsonl`), out.join('\n') + '\n');
  console.log(`${code}: ${out.length} records`);
}
