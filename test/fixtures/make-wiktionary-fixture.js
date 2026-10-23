#!/usr/bin/env node
// Regenerates wiktionary-zh.jsonl from the full kaikki.org Chinese extract:
//   node test/fixtures/make-wiktionary-fixture.js /mnt/biglinks/wiktionary/kaikki.org-dictionary-Chinese.jsonl
// Keeps the records of WORDS plus the first noun without any Mandarin
// reading, reduced to the fields sources/wiktionary-zh.js reads.
import { createReadStream, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';

const WORDS = new Set('日本語 人不像人，鬼不像鬼 綠色 發展 发 發 你好 中國 中国 學習 学习 女 綠 花兒 一下 嗯 了 GDP AA制 卡拉OK 西安 一點兒 煙草 乾杯 馬 安心'.split(' '));
const MAX_SENSES = 4;
const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => k in obj).map((k) => [k, obj[k]]));
const hasMandarin = (d) => (d.sounds ?? []).some((s) => (s.tags ?? []).includes('Mandarin'));

const out = [];
let noMandarin = null;
const rl = createInterface({ input: createReadStream(process.argv[2], 'utf8'), crlfDelay: Infinity });
for await (const line of rl) {
  const d = JSON.parse(line);
  let keep = WORDS.has(d.word);
  if (!keep && noMandarin === null && d.pos === 'noun' && /[一-鿿]/.test(d.word) && d.senses?.length && !hasMandarin(d)) {
    noMandarin = d.word;
    keep = true;
  }
  if (!keep) continue;
  const r = { word: d.word, pos: d.pos };
  if (d.redirects) r.redirects = d.redirects;
  if (d.forms) r.forms = d.forms.filter((f) => (f.tags ?? []).join(' ').includes('Chinese')).map((f) => pick(f, ['form', 'tags']));
  r.sounds = [
    ...(d.sounds ?? []).filter((s) => 'zh_pron' in s && (s.tags ?? []).includes('Mandarin')).map((s) => pick(s, ['zh_pron', 'tags', 'raw_tags'])),
    ...(d.sounds ?? []).filter((s) => 'audio' in s).map((s) => pick(s, ['audio', 'tags'])),
    // Other varieties and systems, for the details (a few of each kind).
    ...(d.sounds ?? []).filter((s) => ('zh_pron' in s || 'ipa' in s) && !(s.tags ?? []).includes('Mandarin')).slice(0, 8)
      .map((s) => pick(s, ['zh_pron', 'ipa', 'tags'])),
    ...(d.sounds ?? []).filter((s) => 'ipa' in s && (s.tags ?? []).includes('Mandarin')).slice(0, 2).map((s) => pick(s, ['ipa', 'tags'])),
  ];
  r.senses = (d.senses ?? []).slice(0, MAX_SENSES).map((s) => ({
    ...pick(s, ['glosses', 'raw_glosses', 'tags']),
    ...(s.examples ? { examples: s.examples.slice(0, 4).map((x) => pick(x, ['text', 'roman', 'english', 'tags', 'type'])) } : {}),
  }));
  if (d.etymology_text) r.etymology_text = d.etymology_text;
  for (const rel of ['synonyms', 'antonyms', 'related', 'derived']) {
    if (d[rel]) r[rel] = d[rel].slice(0, 6).map((x) => pick(x, ['word', 'roman', 'english', 'sense']));
  }
  out.push(JSON.stringify(r));
}
writeFileSync(join(import.meta.dirname, 'wiktionary-zh.jsonl'), out.join('\n') + '\n');
console.log(`${out.length} records; no-Mandarin sample: ${noMandarin}`);
