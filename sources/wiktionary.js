// Source plugin: any language of English Wiktionary as extracted by
// wiktextract (kaikki.org, one JSONL file per language, see
// scripts/kaikki-languages.js). Wiktionary content is CC BY-SA 4.0 and GFDL.
// Chinese has its own specialization (sources/wiktionary-zh.js: simplified
// and traditional forms, numbered pinyin).
//
// Mapping to {simp, trad, pinyin, definition}:
// - simp: the page title (`word`).
// - trad: one alternative written form, or '': for Japanese the kana
//   reading of a word written with kanji (東京 -> とうきょう); for Korean the hangeul
//   of a hanja word (學校 -> 학교); otherwise the canonical form when it
//   differs from the title and adds no words (Latin amo -> amō, Arabic
//   كتاب -> كِتَاب).
// - pinyin: the romanization Wiktionary gives (a form tagged
//   "romanization": romaji for Japanese, Revised Romanization for Korean,
//   transliteration for Cyrillic, Greek, Arabic and so on), only for titles
//   not written in Latin script, else ''.
// - definition: the glosses as for Chinese, "(pos) gloss/gloss", records of
//   one title, alternative form and romanization merged in file order.
// - audio: up to two Wikimedia Commons file names of recordings.
// - details: the detail page (sources/wiktionary-details.js), as JSON text;
//   options.details false leaves it out, options.examples false its examples.
// Records of pos "soft-redirect" and "romanization" and records without a
// gloss yield no entry.
//
// info (optional) receives the index header metadata: language {code, name,
// script, hasRomanization} from the records (lang_code, lang) and the most
// common script of the titles, keys {headword: 'fold', romanization: 'fold'}.
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { definitionOf } from './wiktionary-zh.js';
import { loadWordfreq, WORDFREQ_ATTRIBUTION, WORDFREQ_VERSION } from '../lib/wordfreq.js';
import { addPart, detailsJson, partJson, sortByHeadword } from './wiktionary-details.js';

const SKIPPED_POS = new Set(['soft-redirect', 'romanization']);
export const KEYS = Object.freeze({ headword: 'fold', romanization: 'fold' });
// Share of entries with a romanization above which the language counts as
// romanized (some Latin-script titles of non-Latin languages have none).
const ROMANIZED_SHARE = 0.3;

// ISO 15924 code -> Unicode script of a title's first letter.
const SCRIPTS = [
  ['Latn', 'Latin'], ['Cyrl', 'Cyrillic'], ['Grek', 'Greek'], ['Arab', 'Arabic'], ['Hebr', 'Hebrew'],
  ['Hani', 'Han'], ['Hira', 'Hiragana'], ['Kana', 'Katakana'], ['Hang', 'Hangul'], ['Deva', 'Devanagari'],
  ['Beng', 'Bengali'], ['Guru', 'Gurmukhi'], ['Gujr', 'Gujarati'], ['Orya', 'Oriya'], ['Taml', 'Tamil'],
  ['Telu', 'Telugu'], ['Knda', 'Kannada'], ['Mlym', 'Malayalam'], ['Sinh', 'Sinhala'], ['Thai', 'Thai'],
  ['Laoo', 'Lao'], ['Tibt', 'Tibetan'], ['Mymr', 'Myanmar'], ['Khmr', 'Khmer'], ['Geor', 'Georgian'],
  ['Armn', 'Armenian'], ['Ethi', 'Ethiopic'], ['Mong', 'Mongolian'], ['Syrc', 'Syriac'], ['Thaa', 'Thaana'],
  ['Cher', 'Cherokee'], ['Cans', 'Canadian_Aboriginal'], ['Runr', 'Runic'], ['Goth', 'Gothic'], ['Copt', 'Coptic'],
  ['Ogam', 'Ogham'], ['Tfng', 'Tifinagh'], ['Yiii', 'Yi'], ['Java', 'Javanese'], ['Bali', 'Balinese'],
  ['Xsux', 'Cuneiform'], ['Egyp', 'Egyptian_Hieroglyphs'], ['Linb', 'Linear_B'], ['Ital', 'Old_Italic'],
  ['Xpeo', 'Old_Persian'], ['Ugar', 'Ugaritic'], ['Phnx', 'Phoenician'], ['Brah', 'Brahmi'], ['Glag', 'Glagolitic'],
].map(([iso, name]) => [iso, new RegExp(`^\\p{Script=${name}}`, 'u')]);
const FIRST_LETTER_RE = /\p{L}/u;
const LATIN_RE = /^\p{Script=Latin}/u;
const HAN_RE = /\p{Script=Han}/u;
const KANA_RE = /^[\p{Script=Hiragana}\p{Script=Katakana}ー・ ]+$/u;

export function scriptOf(text) {
  const m = text.match(FIRST_LETTER_RE);
  if (!m) return null;
  for (const [iso, re] of SCRIPTS) if (re.test(m[0])) return iso;
  return 'Zyyy';
}

function formsTagged(record, tag) {
  return (record.forms ?? []).filter((f) => typeof f.form === 'string' && (f.tags ?? []).includes(tag)).map((f) => f.form);
}

// Kana spelling of a Japanese title with kanji: the furigana of its
// canonical form put in place of the kanji (東京 + 東:とう 京:きょう ->
// とうきょう), else a pronunciation spelt in kana, else ''.
export function kanaReading(record) {
  const word = record.word;
  for (const f of record.forms ?? []) {
    if (!Array.isArray(f.ruby) || !(f.tags ?? []).includes('canonical')) continue;
    let out = '';
    let at = 0;
    for (const [base, reading] of f.ruby) {
      const i = word.indexOf(base, at);
      if (i < 0 || typeof reading !== 'string') break;
      out += word.slice(at, i) + reading;
      at = i + base.length;
    }
    out += word.slice(at);
    if (KANA_RE.test(out)) return out;
  }
  for (const s of record.sounds ?? []) if (typeof s.other === 'string' && KANA_RE.test(s.other)) return s.other;
  return '';
}

export function alternativeForm(record) {
  const word = record.word;
  if (record.lang_code === 'ja' && HAN_RE.test(word)) return kanaReading(record);
  const [hangeul] = formsTagged(record, 'hangeul');
  if (hangeul && hangeul !== word) return hangeul;
  const words = word.split(/\s+/).length;
  for (const form of formsTagged(record, 'canonical')) {
    if (form !== word && form.split(/\s+/).length === words) return form;
  }
  return '';
}

export function romanizationOf(record) {
  const word = record.word;
  const m = word.match(FIRST_LETTER_RE);
  if (!m || LATIN_RE.test(m[0])) return '';
  const spaced = /\s/.test(word);
  for (const form of formsTagged(record, 'romanization')) {
    // "Jōyō kanji" is a category, not the reading of a one-word title.
    if (!spaced && /\s/.test(form)) continue;
    const letter = form.match(FIRST_LETTER_RE);
    if (letter && LATIN_RE.test(letter[0])) return form.trim();
  }
  return '';
}

// Pronunciation files (Wikimedia Commons names), the first MAX_AUDIO
// distinct ones in the record's order.
export const MAX_AUDIO = 2;
export function audioOf(record) {
  const names = [];
  for (const s of record.sounds ?? []) {
    if (typeof s.audio === 'string' && s.audio !== '' && !names.includes(s.audio) && names.length < MAX_AUDIO) names.push(s.audio);
  }
  return names;
}

// Maps one parsed JSONL record to its entry, or null.
export function recordEntry(record) {
  if (SKIPPED_POS.has(record.pos) || typeof record.word !== 'string' || record.word.trim() === '') return null;
  const definition = definitionOf(record);
  if (definition === '') return null;
  return { simp: record.word, trad: alternativeForm(record), pinyin: romanizationOf(record), definition, audio: audioOf(record) };
}

async function* records(path) {
  const rl = createInterface({ input: createReadStream(path, 'utf8'), crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.trim() === '') continue;
    yield JSON.parse(line);
  }
}

// Frequency hook: options.wordfreq is the path of a wordfreq list of the same
// language (lib/wordfreq.js; about 40 languages have one); an entry gets the
// Zipf frequency of its lowercased title as `freq`. Without it entries have
// no frequency and rank by headword length. Not used by scripts/build-all.js
// yet, which passes a list for Chinese only.
export async function* entries(path, info = {}, options = {}) {
  const merged = new Map();
  const scripts = new Map();
  let code = null;
  let name = null;
  for await (const record of records(path)) {
    code ??= record.lang_code ?? null;
    name ??= record.lang ?? null;
    const e = recordEntry(record);
    if (!e) continue;
    const part = options.details !== false ? partJson(record, { examples: options.examples !== false }) : null;
    const key = `${e.simp}\t${e.trad}\t${e.pinyin}`;
    const prev = merged.get(key);
    if (prev) {
      prev.definition += `/${e.definition}`;
      for (const a of e.audio) if (prev.audio.length < MAX_AUDIO && !prev.audio.includes(a)) prev.audio.push(a);
      if (options.details !== false) prev.details = addPart(prev.details, record.word, part);
    } else {
      if (options.details !== false) e.details = addPart(null, record.word, part);
      merged.set(key, e);
      const s = scriptOf(e.simp);
      if (s) scripts.set(s, (scripts.get(s) ?? 0) + 1);
    }
  }
  let script = [...scripts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'Zyyy';
  if (code === 'ja') script = 'Jpan';
  if (code === 'ko') script = 'Kore';
  let romanized = 0;
  for (const e of merged.values()) if (e.pinyin !== '') romanized++;
  info.language = { code, name, script, hasRomanization: merged.size > 0 && romanized / merged.size >= ROMANIZED_SHARE };
  info.keys = KEYS;
  info.source = { name: 'English Wiktionary via kaikki.org (wiktextract)', url: 'https://kaikki.org/dictionary/' };
  if (options.wordfreq) {
    const zipf = await loadWordfreq(options.wordfreq);
    for (const e of merged.values()) {
      const z = zipf.get(e.simp.toLowerCase());
      if (z !== undefined) e.freq = z;
    }
    info.source.frequency = { name: WORDFREQ_ATTRIBUTION, version: WORDFREQ_VERSION, license: 'CC BY-SA 4.0' };
  }
  info.textOffsets = 'bytes';
  for (const e of options.sort === false ? merged.values() : sortByHeadword([...merged.values()], KEYS)) {
    if (e.details) e.details = detailsJson(e.details);
    yield e;
  }
}
