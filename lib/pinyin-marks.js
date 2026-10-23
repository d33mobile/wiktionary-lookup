// Tone-marked pinyin ("Zhōngguó", "nǐ hǎo", "jì-dì-pì", "huār") to the
// numbered form every source yields ("Zhong1 guo2", "ni3 hao3",
// "ji4 di4 pi4", "hua1 r5"). Build-time only (reads syllables.json with
// node:fs); the browser engine never imports it.
//
// Words are often written without spaces, so each run of letters is split
// into syllables with a small dynamic programme over the standard syllable
// table. A split is rejected when one syllable would carry two tone marks,
// and penalised when a syllable other than the first starts with a, e or o
// (pinyin writes an apostrophe there: "Xī'ān", "dàng'àn"), which separates
// "dàngàn" (dan gan) from "dàng àn". Among the remaining splits the one with
// the fewest syllables wins. A trailing erhua "r" becomes its own "r5"
// syllable, as in CC-CEDICT.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const TONE_OF_MARK = {
  '̄': 1, // macron
  '́': 2, // acute
  '̌': 3, // caron
  '̆': 3, // breve, a common typo for the caron
  '̀': 4, // grave
};
const DIAERESIS = '̈';
const CIRCUMFLEX = '̂'; // ê; the syllable is spelt "e" here
const NEUTRAL_TONE = 5;
const ERHUA = 'r';

// The source table writes ü as v and lists bare initials (b, c, d ...) as
// standalone syllables; keep only real syllables plus the nasal
// interjections m, n, ng, hm, hng. "r" is handled as erhua below.
const NASALS = new Set(['m', 'n', 'ng', 'hm', 'hng']);
const SYLLABLES = new Set(
  JSON.parse(readFileSync(join(import.meta.dirname, '..', 'syllables.json'), 'utf8'))
    .filter((s) => /[aeiouv]/.test(s) || NASALS.has(s)),
);
const MAX_SYLLABLE_LENGTH = Math.max(...[...SYLLABLES].map((s) => s.length));

const VOWEL_START_PENALTY = 100;
const ERHUA_PENALTY = 1;
const SYLLABLE_COST = 10;

// One run of letters -> {letters, tones, upper}: letters lower-cased with ü as
// v, tones[i] the tone mark on letter i (0 = none), upper[i] its case.
function decompose(run) {
  const letters = [];
  const tones = [];
  const upper = [];
  for (const ch of run.normalize('NFD')) {
    if (ch in TONE_OF_MARK) {
      if (tones.length) tones[tones.length - 1] = TONE_OF_MARK[ch];
    } else if (ch === DIAERESIS) {
      if (letters.length && letters[letters.length - 1] === 'u') letters[letters.length - 1] = 'v';
    } else if (ch === CIRCUMFLEX) {
      // ê stays e
    } else {
      const lower = ch.toLowerCase();
      letters.push(lower);
      tones.push(0);
      upper.push(lower !== ch);
    }
  }
  return { letters: letters.join(''), tones, upper };
}

// Best split of `letters` into syllables as [[start, end, isErhua]], or null.
function segment(letters, tones) {
  const n = letters.length;
  const best = new Array(n + 1).fill(Infinity);
  const back = new Array(n + 1).fill(null);
  best[0] = 0;
  for (let i = 0; i < n; i++) {
    if (best[i] === Infinity) continue;
    const consider = (j, erhua) => {
      let marks = 0;
      for (let k = i; k < j; k++) if (tones[k]) marks++;
      if (marks > 1) return;
      let cost = best[i] + SYLLABLE_COST;
      if (i > 0 && !erhua && /[aeo]/.test(letters[i])) cost += VOWEL_START_PENALTY;
      if (erhua) cost += ERHUA_PENALTY;
      if (cost < best[j]) {
        best[j] = cost;
        back[j] = [i, j, erhua];
      }
    };
    for (let len = 1; len <= MAX_SYLLABLE_LENGTH && i + len <= n; len++) {
      if (SYLLABLES.has(letters.slice(i, i + len))) consider(i + len, false);
    }
    // Erhua: an "r" after a syllable that is not followed by a vowel.
    if (i > 0 && letters[i] === ERHUA && !/[aeiouv]/.test(letters[i + 1] ?? '')) consider(i + 1, true);
  }
  if (best[n] === Infinity) return null;
  const parts = [];
  for (let j = n; j > 0; j = back[j][0]) parts.unshift(back[j]);
  return parts;
}

function renderSyllable(letters, tones, upper, start, end) {
  let text = letters.slice(start, end).replace(/v/g, 'ü');
  if (upper[start]) text = text[0].toUpperCase() + text.slice(1);
  let tone = NEUTRAL_TONE;
  for (let k = start; k < end; k++) if (tones[k]) tone = tones[k];
  return text + tone;
}

// Converts one run of letters; a run that cannot be split into syllables
// (a Latin abbreviation, a typo) is returned lower-cased without digits so
// it still matches the bare pinyin key.
export function convertRun(run) {
  const { letters, tones, upper } = decompose(run);
  if (letters === '') return [];
  const parts = segment(letters, tones);
  if (!parts) return [run.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()];
  return parts.map(([s, e, erhua]) => (erhua ? `${ERHUA}${NEUTRAL_TONE}` : renderSyllable(letters, tones, upper, s, e)));
}

// "Zhōngguó" -> "Zhong1 guo2"; "yī (yi¹)" -> "yi1"; "jì-dì-pì" -> "ji4 di4 pi4".
// Spaces, hyphens and apostrophes separate syllables; "," and "·" are kept
// as their own tokens (CC-CEDICT does the same); sentence punctuation
// (! ? .) is dropped, and so is a trailing note in parentheses or brackets
// ("yī (yi¹)", "Rìběnyǔ [Phonetic: rìbényǔ", wiktextract leaves the bracket
// unclosed).
export function toneMarksToNumbers(text) {
  const out = [];
  const cleaned = text.replace(/\s*[([].*$/s, '').trim();
  for (const token of cleaned.split(/[\s\-‐'’!?.！？。]+/u)) {
    for (const piece of token.split(/([,·，])/u)) {
      if (piece === '') continue;
      if (/^[,·，]$/u.test(piece)) out.push(piece === '，' ? ',' : piece);
      else out.push(...convertRun(piece));
    }
  }
  return out.join(' ');
}
