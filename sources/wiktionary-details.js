// Details of a Wiktionary entry for the detail view (Wiktionary-like page),
// built from wiktextract records (kaikki.org). One entry merges one or more
// records (parts of speech, etymologies); its details are
//
//   {title, records: [{
//     pos,                                   part of speech ("noun")
//     senses: [{gloss, examples?: [{text, roman?, english?}]}],
//     etymology?,                            etymology_text, at most ETYMOLOGY_MAX chars
//     forms?: [{form, tags?}],               inflections, alternative/variant forms
//     sounds?: [{text, kind, tags?}],        pronunciations other than recordings:
//                                            kind ipa | zh_pron | enpr | other
//     synonyms?, antonyms?, related?, derived?: [{word, roman?, sense?}],
//   }]}
//
// title is the Wiktionary page title (https://en.wiktionary.org/wiki/<title>).
// Caps keep the size bounded: see the constants. Empty fields are left out.
export const MAX_EXAMPLES = 3;
export const EXAMPLE_MAX = 300;
export const ETYMOLOGY_MAX = 600;
export const MAX_FORMS = 150;
export const MAX_SOUNDS = 24;
export const MAX_RELATED = 20;
export const MAX_RECORDS = 12;
const RELATIONS = ['synonyms', 'antonyms', 'related', 'derived'];
const SKIPPED_FORM_TAGS = new Set(['table-tags', 'inflection-template', 'class', 'romanization']);
const SOUND_KINDS = ['ipa', 'zh_pron', 'enpr', 'other'];
// Chinese records list every topolect in several transcription systems
// (three quarters of the details). One system per variety is kept: Pinyin
// and Bopomofo, Jyutping, POJ, Peng'im, Phak-fa-su ..., and Sinological IPA
// for Mandarin and Cantonese only.
const ZH_DROPPED_SYSTEMS = new Set([
  'Wade-Giles', 'Gwoyeu-Romatsyh', 'Yale', 'Tongyong-Pinyin', 'Palladius', 'Guangdong-Romanization', 'Tai-lo',
  'Phofsit-Daibuun', 'Hakka-Romanization-System', 'Hagfa-Pinyim', 'Wiktionary-specific', 'Cyrillic',
]);
function keepChineseSound(tags) {
  if (tags.some((t) => ZH_DROPPED_SYSTEMS.has(t))) return false;
  if (tags.includes('Cantonese') && tags.includes('Pinyin')) return false;
  if (tags.includes('Sinological-IPA') && !tags.includes('Mandarin') && !tags.includes('Cantonese')) return false;
  return true;
}

const cut = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const str = (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

function examplesOf(sense, chinese) {
  const all = (sense.examples ?? []).filter((x) => str(x.text));
  // Chinese examples come as a Traditional / Simplified pair: keep one.
  const list = chinese && all.some((x) => (x.tags ?? []).includes('Simplified-Chinese'))
    ? all.filter((x) => !(x.tags ?? []).includes('Traditional-Chinese'))
    : all;
  return list.slice(0, MAX_EXAMPLES).map((x) => {
    const out = { text: cut(x.text.trim(), EXAMPLE_MAX) };
    const roman = str(x.roman);
    const english = str(x.english) ?? str(x.translation);
    if (roman) out.roman = cut(roman, EXAMPLE_MAX);
    if (english) out.english = cut(english, EXAMPLE_MAX);
    return out;
  });
}

function relationList(items) {
  const out = [];
  const seen = new Set();
  let last = null;
  for (const x of items ?? []) {
    const word = str(x.word);
    if (!word || seen.has(word)) continue;
    seen.add(word);
    // Chinese lists give each word twice, traditional then simplified.
    if (last && x.roman && x.roman === last.roman && (x.english ?? '') === (last.english ?? '')
      && [...word].length === [...str(last.word)].length) continue;
    last = x;
    const r = { word };
    const roman = str(x.roman);
    const sense = str(x.sense) ?? str(x.english);
    if (roman) r.roman = roman;
    if (sense) r.sense = cut(sense, 120);
    out.push(r);
    if (out.length >= MAX_RELATED) break;
  }
  return out;
}

// etymology_text without the "Etymology tree" kaikki puts in front (one
// ancestor per line, ending with the line "<language> <word>").
export function etymologyText(record) {
  const text = record.etymology_text;
  if (typeof text !== 'string' || !text.startsWith('Etymology tree\n')) return text;
  const lines = text.split('\n');
  const end = lines.indexOf(`${record.lang} ${record.word}`);
  return lines.slice(end > 0 ? end + 1 : 1).join('\n');
}

// One record -> its part of the details, or null without senses.
// options.examples false leaves examples out (size measurements).
export function recordDetails(record, { chinese = false, examples = true } = {}) {
  const senses = [];
  for (const s of record.senses ?? []) {
    const raw = s.raw_glosses ?? s.glosses ?? [];
    const gloss = str(raw[raw.length - 1]);
    if (!gloss) continue;
    const sense = { gloss };
    if (examples) {
      const ex = examplesOf(s, chinese);
      if (ex.length) sense.examples = ex;
    }
    senses.push(sense);
  }
  if (senses.length === 0) return null;
  const out = { pos: record.pos, senses };
  const ety = str(etymologyText(record));
  if (ety) out.etymology = cut(ety, ETYMOLOGY_MAX);
  const forms = [];
  for (const f of record.forms ?? []) {
    const form = str(f.form);
    const tags = (f.tags ?? []).filter((t) => t !== 'canonical');
    if (!form || form === record.word || (f.tags ?? []).some((t) => SKIPPED_FORM_TAGS.has(t))) continue;
    forms.push(tags.length ? { form, tags } : { form });
    if (forms.length >= MAX_FORMS) break;
  }
  if (forms.length) out.forms = forms;
  const sounds = [];
  const seenSounds = new Set();
  for (const s of record.sounds ?? []) {
    const kind = SOUND_KINDS.find((k) => str(s[k]));
    if (!kind || seenSounds.has(`${kind}\t${s[kind]}`)) continue;
    seenSounds.add(`${kind}\t${s[kind]}`);
    const tags = s.tags ?? [];
    if (chinese && !keepChineseSound(tags)) continue;
    sounds.push(tags.length ? { text: s[kind].trim(), kind, tags } : { text: s[kind].trim(), kind });
    if (sounds.length >= MAX_SOUNDS) break;
  }
  if (sounds.length) out.sounds = sounds;
  for (const rel of RELATIONS) {
    const list = relationList([...(record[rel] ?? []), ...(record.senses ?? []).flatMap((s) => s[rel] ?? [])]);
    if (list.length) out[rel] = list;
  }
  return out;
}

// Sources keep an entry's details as {title, parts: [JSON of recordDetails]}
// while they merge records (strings are much smaller than the objects) and
// turn them into the JSON text of the details object when they yield it.
export function addPart(details, title, partJson) {
  const d = details ?? { title, parts: [] };
  if (partJson !== null && d.parts.length < MAX_RECORDS) d.parts.push(partJson);
  return d;
}

export function detailsJson(details) {
  if (!details || details.parts.length === 0) return null;
  return `{"title":${JSON.stringify(details.title)},"records":[${details.parts.join(',')}]}`;
}

export function partJson(record, options) {
  const part = recordDetails(record, options);
  return part ? JSON.stringify(part) : null;
}
