// Key normalisation shared by the index builder and the lookup engine.
// Both sides MUST derive keys through these functions, otherwise the
// sorted order arrays and the bisect comparisons disagree.

// Lower-case, map u-umlaut (CC-CEDICT writes it "u:") to "v" like most IMEs,
// drop everything except letters and tone digits: "ni3 hao3" -> "ni3hao3".
export function pinyinToned(pinyin) {
  return pinyin.toLowerCase().replace(/u:|ü/g, 'v').replace(/[^a-z0-9]/g, '');
}

// Same as pinyinToned without tone digits: "ni3 hao3" -> "nihao".
export function pinyinBare(pinyin) {
  return pinyinToned(pinyin).replace(/[0-9]/g, '');
}

// String.prototype.matchAll is Chromium 73; the engine also runs in older
// Android WebViews. `re` must have the g flag. It is reused rather than
// copied: old V8 recompiles every new RegExp, and a \p{L} class is costly.
function allMatches(text, re) {
  const out = [];
  re.lastIndex = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) out.push(m);
  re.lastIndex = 0;
  return out;
}

const WORD_RE = /[\p{L}\p{N}]+/gu;

// Words of an English definition used for the definition index: maximal
// runs of letters and digits with Latin diacritics removed, lowercased, kept
// only when they are plain ASCII ("Lǚshùnkǒu" -> "lushunkou", "zhīshi" ->
// "zhishi"; runs with CJK or other scripts are dropped). Each token says
// whether it was written in lower case (`lower`), which tells an English word
// from a capitalised name ("surname Shi").
export function definitionTokens(text) {
  const out = [];
  for (const m of allMatches(stripMarks(text), WORD_RE)) {
    const word = m[0].toLowerCase();
    // The pronoun "I" is an English word although it is written in capitals.
    if (/^[a-z0-9]+$/.test(word)) out.push({ word, lower: word === m[0] || m[0] === 'I' });
  }
  return out;
}

export function definitionWords(definition) {
  return definitionTokens(definition).map((t) => t.word);
}

// Latin/Greek/Cyrillic combining diacritics (U+0300-U+036F) removed.
function stripMarks(text) {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').normalize('NFC');
}

// Gloss keys of a definition ("(noun) (vulgar) shit; feces/to defecate"):
// senses are separated by "/", glosses inside a sense by ";" or ",". A gloss
// loses every parenthesis (before the split, so "(Classifier: 坨 m; 篤 c)"
// does not split), final punctuation and a leading "to", "a", "an" or "the";
// what is left, at most
// GLOSS_MAX_WORDS words and nothing but words, spaces, hyphens and
// apostrophes, becomes the key definitionWords(gloss).join(' '). Returns
// Map key -> score (lower is better): bit 7 set when the gloss is
// capitalised (a name), bit 6 when its sense carries a label that restricts
// it (not a part of speech or one of NEUTRAL_LABELS), bits 0-5 the sense position (capped at 63).
export const GLOSS_MAX_WORDS = 4;
export const GLOSS_CAPITALISED = 0x80;
export const GLOSS_QUALIFIED = 0x40;
export const GLOSS_SENSE_MASK = 0x3f;

// Gloss quality bucket of a score, ranked before frequency by the engine:
// 0 = unrestricted gloss in one of the first PRIMARY_SENSES senses ("(pron)
// (interrogative) what" of 什么, "big" of 大 "of great size; big"),
// 1 = unrestricted later sense, 2 = restricted sense ("(obsolete)",
// "(Hokkien)").
export const PRIMARY_SENSES = 2;
export const GLOSS_RESTRICTED = 2;
export function glossBucket(score) {
  if (score & GLOSS_QUALIFIED) return GLOSS_RESTRICTED;
  return (score & GLOSS_SENSE_MASK) < PRIMARY_SENSES ? 0 : 1;
}
const LEADING_LABELS_RE = /^(?:\(([^()]*)\)\s*)+/;
const LABEL_RE = /\(([^()]*)\)/g;
const PAREN_GROUP_RE = /\s*[(（][^()（）]*[)）]/g;
const GLOSS_FILLER_RE = /^(?:to|a|an|the)\s+/i;
const GLOSS_TEXT_RE = /^[\p{L}\p{N}][\p{L}\p{N}\p{M} '’-]*$/u;
// Parts of speech that sources put in front of a record's first sense.
export const PARTS_OF_SPEECH = new Set([
  'character', 'noun', 'verb', 'adj', 'adv', 'name', 'phrase', 'proverb', 'intj', 'pron', 'classifier', 'conj',
  'particle', 'num', 'prep', 'punct', 'suffix', 'prefix', 'infix', 'interfix', 'circumfix', 'affix', 'symbol', 'det',
  'postp', 'article', 'contraction', 'abbrev', 'counter', 'root', 'prep_phrase', 'adj_noun', 'combining_form', 'adnominal',
  'syllable', 'idiom', 'clitic', 'particle',
]);

// Labels that describe a sense without restricting where or when it is used.
// A label group "(a, b or c)" restricts when any of its labels is neither a
// part of speech nor one of these, nor a place marker such as "(～市)".
export const NEUTRAL_LABELS = new Set([
  'interrogative', 'attributive', 'transitive', 'intransitive', 'figurative', 'figuratively', 'literally',
  'colloquial', 'informal', 'formal', 'by extension', 'Mandarin', 'chiefly Mandarin', 'Standard Chinese',
  'usually', 'often', 'especially', 'also', 'etc.', 'countable', 'uncountable', 'ditransitive', 'reflexive',
  'stative', 'auxiliary', 'modal', 'copulative', 'ergative', 'impersonal', 'plural', 'singular', 'polite',
]);

function restricts(group) {
  return group.split(/,\s*|\s+or\s+|\s+and\s+/).some((label) => label !== '' && !PARTS_OF_SPEECH.has(label)
    && !NEUTRAL_LABELS.has(label) && !label.startsWith('～'));
}

export function glossKeys(definition) {
  const keys = new Map();
  const senses = definition.split('/');
  for (let i = 0; i < senses.length; i++) {
    const lead = senses[i].match(LEADING_LABELS_RE);
    let qualified = false;
    if (lead) for (const m of allMatches(lead[0], LABEL_RE)) if (restricts(m[1])) qualified = true;
    let text = senses[i].slice(lead ? lead[0].length : 0);
    for (let prev = ''; prev !== text;) [prev, text] = [text, text.replace(PAREN_GROUP_RE, ' ')];
    for (let part of text.split(/[;,]/)) {
      part = part.trim().replace(/[.!?]+$/, '').replace(GLOSS_FILLER_RE, '');
      if (!GLOSS_TEXT_RE.test(part)) continue;
      const tokens = definitionTokens(part);
      if (tokens.length === 0 || tokens.length > GLOSS_MAX_WORDS) continue;
      const key = tokens.map((t) => t.word).join(' ');
      const score = (tokens.every((t) => t.lower) ? 0 : GLOSS_CAPITALISED) | (qualified ? GLOSS_QUALIFIED : 0)
        | Math.min(i, GLOSS_SENSE_MASK);
      if (!keys.has(key) || keys.get(key) > score) keys.set(key, score);
    }
  }
  return keys;
}

// BMP CJK blocks plus every supplementary-plane character in planes 2 and 3
// (CJK extensions B through I live there, e.g. biang U+30EDD).
const CJK_RE = /[\u2E80-\u2FDF\u3005-\u3007\u3021-\u3029\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]|[\uD840-\uD8BF][\uDC00-\uDFFF]/;
const PINYIN_QUERY_RE = /^[a-zA-Z0-9üÜ:\s]+$/;

export function hasCjk(text) {
  return CJK_RE.test(text);
}

export function looksLikePinyin(text) {
  return PINYIN_QUERY_RE.test(text);
}

// Number of code points (one CJK character = one, even outside the BMP).
export function codePointLength(text) {
  let n = 0;
  for (const _ of text) n++;
  return n;
}

// Letters with no canonical decomposition that people commonly type without
// the stroke (Polish l-stroke, Croatian d-stroke, Danish o-slash, ...).
const FOLD_LETTERS = { ł: 'l', đ: 'd', ø: 'o', ħ: 'h', ı: 'i', ŀ: 'l' };
const FOLD_LETTERS_RE = /[łđøħıŀ]/g;

// Search key of a headword in a 'fold' index (generic Wiktionary languages):
// lower case, Latin/Greek/Cyrillic combining diacritics removed ("Größe" ->
// "große", "Москва́" -> "москва", "ἄνθρωπος" -> "ανθρωπος"). Only U+0300-U+036F
// is dropped, so kana voicing marks (が) and Hangul stay intact after NFC.
export function foldText(text) {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(FOLD_LETTERS_RE, (c) => FOLD_LETTERS[c]).normalize('NFC');
}

// Search key of a romanization in a 'fold' index: folded, letters and digits
// only, so spaces, hyphens and apostrophes do not matter ("Ō-saka" -> "osaka").
export function romanizationKey(text) {
  return foldText(text).replace(/[^\p{L}\p{N}]/gu, '');
}

const identity = (s) => s;

// Key derivations named by the index header field `keys` ({headword,
// romanization}); an index without the field uses the original Chinese
// scheme, {headword: 'exact', romanization: 'pinyin'}.
export function keyFunctions(keys = {}) {
  const headword = keys.headword || 'exact';
  const romanization = keys.romanization || 'pinyin';
  if (headword !== 'exact' && headword !== 'fold') throw new Error(`unknown headword key scheme ${headword}`);
  if (romanization !== 'pinyin' && romanization !== 'fold') throw new Error(`unknown romanization key scheme ${romanization}`);
  return {
    headword: headword === 'fold' ? foldText : identity,
    romanizationToned: romanization === 'fold' ? romanizationKey : pinyinToned,
    romanizationBare: romanization === 'fold' ? romanizationKey : pinyinBare,
    scheme: { headword, romanization },
  };
}
