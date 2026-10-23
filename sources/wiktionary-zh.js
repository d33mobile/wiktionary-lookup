// Source plugin: Chinese entries of English Wiktionary as extracted by
// wiktextract (kaikki.org, https://kaikki.org/dictionary/Chinese/), one JSON
// object per line. Wiktionary content is CC BY-SA 4.0 and GFDL.
//
// Mapping to {simp, trad, pinyin, definition}:
// - trad is the page title (`word`); simp is its form tagged
//   "Simplified-Chinese" (not "alternative", not second-round), or `word`.
//   Single-character pages carry no simplified form in the extract (the
//   trad./simp. box sits in the Translingual section), so for them simp is
//   the character's most common counterpart in the two-script word pairs of
//   the same file (綠 -> 绿 from 綠色/绿色, 綠茶/绿茶 ...); a character that
//   occurs in no multi-character word keeps simp = trad. Soft-redirect pages
//   are not used for this: most of them point variant characters at the
//   standard one (侓 -> 律), not simplified at traditional.
//   Records of pos "soft-redirect" yield no entry, nor do records without a
//   gloss or titles without Hanzi.
// - pinyin: every distinct Standard Chinese reading in `sounds` (zh_pron
//   tagged Mandarin + Pinyin + Standard-Chinese, falling back to Standard and
//   then to plain Mandarin + Pinyin; erhua, phonetic, toneless and dialect
//   variants excluded), converted from tone marks to tone numbers by
//   lib/pinyin-marks.js. One entry per reading; a record without a
//   Mandarin reading (Cantonese-only words and so on) yields one entry with
//   empty pinyin, still found by headword and definition.
// - audio: up to two Wikimedia Commons file names of recordings (audioFor).
// - definition: glosses (the most specific one of each sense, with its
//   label prefix such as "(Classical)"), joined with "/", each part of
//   speech introduced by "(noun) ". Records with the same trad, simp and
//   reading (several etymologies or parts of speech of one page) are merged
//   into one entry, in file order.
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { hasCjk, pinyinToned } from '../lib/normalize.js';
import { toneMarksToNumbers } from '../lib/pinyin-marks.js';
import { loadWordfreq, WORDFREQ_ATTRIBUTION, WORDFREQ_VERSION } from '../lib/wordfreq.js';
import { addPart, detailsJson, partJson, sortByHeadword } from './wiktionary-details.js';

const SKIPPED_POS = new Set(['soft-redirect', 'romanization']);
const EXCLUDED_READING_TAGS = new Set([
  'Erhua', 'phonetic', 'toneless-final-syllable-variant', 'Chengdu', 'Sichuanese', "Xi'an",
  'Nanjing', 'Beijing', 'dialectal', 'Dungan',
]);
const READING_PREFERENCE = ['Standard-Chinese', 'Standard', null];

function simplifiedForm(record) {
  for (const f of record.forms ?? []) {
    const tags = f.tags ?? [];
    if (tags.includes('Simplified-Chinese') && !tags.includes('alternative')
      && !tags.includes('Second-Round-Simplified-Chinese') && hasCjk(f.form)) return f.form;
  }
  return record.word;
}

function isUsableReading(sound) {
  const tags = sound.tags ?? [];
  if (typeof sound.zh_pron !== 'string' || !tags.includes('Mandarin') || !tags.includes('Pinyin')) return false;
  if (tags.some((t) => EXCLUDED_READING_TAGS.has(t))) return false;
  return !(sound.raw_tags ?? []).some((t) => /dialect|variant/.test(t));
}

// wiktextract splits a zh_pron at its commas, so a phrase whose title has k
// commas has every reading spread over k + 1 consecutive pieces, and a
// "[Phonetic: ...]" note (left unclosed) takes k + 1 pieces as well: the
// text before "[" in the piece that opens it, then the next k pieces. This
// drops the notes and joins the remaining pieces back into readings.
export function joinPhrasePieces(pieces, commas) {
  const kept = [];
  let skip = 0;
  for (const piece of pieces) {
    if (skip > 0) {
      skip--;
      continue;
    }
    const bracket = piece.indexOf('[');
    if (bracket >= 0) {
      const before = piece.slice(0, bracket).trim();
      if (before) kept.push(before);
      skip = commas;
    } else {
      kept.push(piece);
    }
  }
  const out = [];
  for (let i = 0; i + commas < kept.length; i += commas + 1) out.push(kept.slice(i, i + commas + 1).join(', '));
  return out;
}

// Every token that is not punctuation carries a tone digit.
const fullyNumbered = (reading) => reading.split(' ').every((t) => /^[,·]$/.test(t) || /[0-9]$/.test(t));

// Distinct numbered readings of the record, best tag group first. Readings
// with a token that is not pinyin ("ka3 la1 ok") are kept only when the
// record has no fully numbered one.
export function readings(record) {
  const usable = (record.sounds ?? []).filter(isUsableReading);
  const commas = (record.word.match(/[,，]/g) ?? []).length;
  for (const wanted of READING_PREFERENCE) {
    const group = usable.filter((s) => (wanted ? s.tags.includes(wanted) : true));
    if (group.length === 0) continue;
    const out = [];
    for (const raw of joinPhrasePieces(group.map((s) => s.zh_pron), commas)) {
      const numbered = toneMarksToNumbers(raw);
      if (numbered && /[0-9]/.test(numbered) && !out.includes(numbered)) out.push(numbered);
    }
    const clean = out.filter(fullyNumbered);
    if (clean.length) return clean;
    if (out.length) return out;
  }
  return [];
}

function senseText(sense) {
  const raw = sense.raw_glosses ?? sense.glosses ?? [];
  const text = raw[raw.length - 1];
  return typeof text === 'string' ? text.trim() : '';
}

// "(noun) gloss 1/gloss 2" for one record, or '' when it has no gloss.
export function definitionOf(record) {
  const glosses = [];
  for (const sense of record.senses ?? []) {
    const text = senseText(sense);
    if (text && !glosses.includes(text)) glosses.push(text);
  }
  if (glosses.length === 0) return '';
  return `(${record.pos}) ${glosses.join('/')}`;
}

// Pronunciation files (Wikimedia Commons names) for one reading of a record,
// at most MAX_AUDIO: Mandarin recordings, those whose file name spells this
// reading first ("zh-mǎ.ogg" for ma3), recordings whose name spells another
// reading left out. An entry without a Mandarin reading (Cantonese, Hokkien
// ... words) takes any recording.
export const MAX_AUDIO = 2;
export function audioFor(record, pinyin) {
  const sounds = (record.sounds ?? []).filter((s) => typeof s.audio === 'string' && s.audio !== '');
  const names = [];
  const add = (s) => { if (names.length < MAX_AUDIO && !names.includes(s.audio)) names.push(s.audio); };
  if (pinyin === '') {
    sounds.forEach(add);
    return names;
  }
  const want = pinyinToned(pinyin);
  const spelled = (s) => {
    const m = s.audio.match(/^(?:zh|cmn)-([^.]+)\.[a-z0-9]+$/i);
    const numbered = m ? toneMarksToNumbers(m[1]) : null;
    return numbered && /[0-9]/.test(numbered) ? pinyinToned(numbered) : null;
  };
  const mandarin = sounds.filter((s) => (s.tags ?? []).includes('Mandarin') && [null, want].includes(spelled(s)));
  mandarin.filter((s) => spelled(s) === want).forEach(add);
  mandarin.forEach(add);
  return names;
}

// Maps one parsed JSONL record to its entries (possibly none).
export function recordEntries(record) {
  if (SKIPPED_POS.has(record.pos) || typeof record.word !== 'string' || !hasCjk(record.word)) return [];
  const definition = definitionOf(record);
  if (definition === '') return [];
  const trad = record.word;
  const simp = simplifiedForm(record);
  const found = readings(record);
  return (found.length ? found : ['']).map((pinyin) => ({ simp, trad, pinyin, definition, audio: audioFor(record, pinyin) }));
}

async function* records(path) {
  const rl = createInterface({ input: createReadStream(path, 'utf8'), crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.trim() === '') continue;
    yield JSON.parse(line);
  }
}

// trad character -> simplified character it most often becomes inside words
// whose two forms have the same length. Positions where the character stays
// the same count as votes for itself, so one odd word pair (a variant form
// tagged as simplified) does not remap a character that is normally kept.
function characterMap(entryList) {
  const counts = new Map();
  for (const e of entryList) {
    const t = [...e.trad];
    const s = [...e.simp];
    if (t.length < 2 || t.length !== s.length) continue;
    for (let i = 0; i < t.length; i++) {
      let c = counts.get(t[i]);
      if (!c) counts.set(t[i], (c = new Map()));
      c.set(s[i], (c.get(s[i]) ?? 0) + 1);
    }
  }
  const best = new Map();
  for (const [t, c] of counts) {
    const [top] = [...c].sort((a, b) => b[1] - a[1]);
    if (top[0] !== t) best.set(t, top[0]);
  }
  return best;
}

// Fills simp of single-character entries that have none of their own.
export function fillCharacterSimp(entryList) {
  const byWords = characterMap(entryList);
  for (const e of entryList) {
    if (e.simp !== e.trad || [...e.trad].length !== 1) continue;
    const simp = byWords.get(e.trad);
    if (simp) e.simp = simp;
  }
}

export const LANGUAGE = Object.freeze({ code: 'zh', name: 'Chinese', script: 'Hani', hasRomanization: true });
export const KEYS = Object.freeze({ headword: 'exact', romanization: 'pinyin' });

// info (optional) receives the index header metadata.
// Zipf frequencies are of the written word, not of a reading: the first
// reading of a word gets the word's frequency, every further reading this
// much less (one order of magnitude), so 了 le5 comes before 了 liao3.
const SECONDARY_READING_PENALTY = 1;

// Sets `freq` (Zipf frequency, higher = more common) from a wordfreq list
// (lib/wordfreq.js) looked up by the simplified form, which is what the
// list's "oversimplified" Chinese matches. Words not in the list get none.
export function applyFrequencies(list, zipf) {
  const readingsSeen = new Map();
  for (const e of list) {
    const word = `${e.trad}\t${e.simp}`;
    const k = readingsSeen.get(word) ?? 0;
    readingsSeen.set(word, k + 1);
    const z = zipf.get(e.simp);
    if (z !== undefined) e.freq = z - k * SECONDARY_READING_PENALTY;
  }
}

// info (optional) receives the index header metadata. options.wordfreq: path
// of a wordfreq list (large_zh.msgpack.gz) to rank entries by frequency;
// options.details false leaves out the details (sources/wiktionary-details.js),
// options.examples false only their examples.
export async function* entries(path, info = {}, options = {}) {
  info.language = LANGUAGE;
  info.keys = KEYS;
  info.source = { name: 'English Wiktionary via kaikki.org (wiktextract)', url: 'https://kaikki.org/dictionary/Chinese/' };
  const merged = new Map();
  const withDetails = options.details !== false;
  for await (const record of records(path)) {
    const found = recordEntries(record);
    const part = withDetails && found.length ? partJson(record, { chinese: true, examples: options.examples !== false }) : null;
    for (const e of found) {
      const key = `${e.trad}\t${e.simp}\t${e.pinyin}`;
      const prev = merged.get(key);
      if (prev) {
        prev.definition += `/${e.definition}`;
        for (const a of e.audio) if (prev.audio.length < MAX_AUDIO && !prev.audio.includes(a)) prev.audio.push(a);
        if (withDetails) prev.details = addPart(prev.details, record.word, part);
      } else {
        if (withDetails) e.details = addPart(null, record.word, part);
        merged.set(key, e);
      }
    }
  }
  const list = [...merged.values()];
  fillCharacterSimp(list);
  if (options.wordfreq) {
    applyFrequencies(list, await loadWordfreq(options.wordfreq));
    info.source.frequency = { name: WORDFREQ_ATTRIBUTION, version: WORDFREQ_VERSION, license: 'CC BY-SA 4.0' };
  }
  info.textOffsets = 'bytes';
  for (const e of options.sort === false ? list : sortByHeadword(list, KEYS)) {
    if (e.details) e.details = detailsJson(e.details);
    yield e;
  }
}
