// Lookup engine over an index built by build-index.js. Browser-safe: no
// Node imports anywhere on this path (lib/index-format.js, lib/bisect.js,
// lib/normalize.js), so web/ loads it as plain ES modules. Node callers use
// loadIndex(path) from ../lookup.js; browsers fetch the file and call
// openIndex(await response.arrayBuffer()).
//
//   const d = openIndex(bytes);
//   d.search('nihao', { limit: 20 })  // -> [{simp, trad, pinyin, definition, matchedOn}]
//
// d.search() uses one built-in Session; create independent ones with
// d.newSession() (one per input box). A Session remembers the [lo, hi)
// range of every prefix of the current query per sorted key, so typing one
// more character bisects inside the previous range and backspace returns to
// a stored range without bisecting at all.
import {
  NeedBytes, deserializeIndexWithHeader, LOWERCASE_FLAG, ID_MASK, GLOSS_SCORE_SHIFT, GLOSS_ID_MASK,
} from './index-format.js';
import { prefixRange } from './bisect.js';
import {
  definitionWords, hasCjk, looksLikePinyin, keyFunctions, glossBucket, GLOSS_CAPITALISED, GLOSS_SENSE_MASK, GLOSS_RESTRICTED,
} from './normalize.js';

export const DEFAULT_LIMIT = 20;
// Commons redirects this to the file itself (any case of the first letter).
// Entries per details block (build-index.js DETAILS_BLOCK; the header says).
const DETAILS_BLOCK = 64;
const DETAILS_CACHE_BLOCKS = 8;
export const AUDIO_URL_PREFIX = 'https://commons.wikimedia.org/wiki/Special:FilePath/';
const FIELDS_PER_ENTRY = 4;
const FIELD_SIMP = 0;
const FIELD_TRAD = 1;
const FIELD_PINYIN = 2;
const FIELD_DEFINITION = 3;
const DEFINITION_PREFIX = '/';
const ROMANIZATION_PREFIXES = ['p:', ':'];
const ENGLISH_OR_PINYIN_RE = /^[a-zA-Z\s]+$/;

// Page of an entry when the index header has an entryUrl template
// ("https://en.wikipedia.org/wiki/{title}"): the headword with spaces as
// underscores, percent-encoded.
export function entryUrlOf(template, title) {
  return template.replace('{title}', encodeURIComponent(title.replace(/ /g, '_')));
}

// Language of an index written before the header carried one.
export const DEFAULT_LANGUAGE = Object.freeze({ code: 'zh', name: 'Chinese', script: 'Hani', hasRomanization: true });

// Score tiers, lower is better. Inside a tier a candidate's `sub` (gloss
// quality bucket, inflected form) comes first, then frequency, then `fine`
// (sense position), headword length and id (TopK.before). A result keeps the
// best tier through which it was found.
//
// Chinese (pinyin) index, ASCII query: an English gloss that is exactly the
// query ("man" -> 人 "man; person") beats an exact pinyin syllable sequence,
// which beats the query as a lowercase whole word anywhere in a definition
// ("shit" -> 拉屎 "to crap; to shit"), then pinyin prefixes, then
// definition-word prefixes (which include words that occur only capitalised,
// like the name in "surname Shi").
// A gloss restricted by a label ("(mythology) the shen", "(Wu) to shit")
// ranks as a whole word, after the exact pinyin syllables.
const ZH_ASCII = { glossEqual: 0, romanExact: 1, word: 2, restrictedGloss: 2, romanPrefix: 3, defPrefix: 4 };
// Any other index: headword > alternative form / romanization > definition.
const GENERIC = {
  headExact: 0, formExact: 1, romanExact: 1, glossEqual: 2, restrictedGloss: 2, headPrefix: 3, formPrefix: 4, romanPrefix: 4, word: 5,
  defPrefix: 6,
};
const HEADWORD = { exact: 0, prefix: 1 };
const DEFINITION_ONLY = { glossEqual: 0, restrictedGloss: 0, word: 1, defPrefix: 2 };
const ROMANIZATION_ONLY = { romanExact: 0, romanPrefix: 1 };

// rank = frequency rank << RANK_LENGTH_BITS | headword length (build-index.js).
const RANK_LENGTH_BITS = 8;

// Keeps the best `limit` candidates (see before()). An entry
// arriving again through another key replaces its earlier candidate only
// with a better tier, so `matchedOn` names the first key with the best tier.
class TopK {
  constructor(limit) {
    this.limit = limit;
    this.items = [];
    this.byId = new Map();
  }

  full() {
    return this.items.length >= this.limit;
  }

  worst() {
    return this.items[this.items.length - 1];
  }

  // True when no candidate of this tier can enter any more.
  closedFor(tier) {
    return this.full() && this.worst().tier < tier;
  }

  // Order: tier, sub, frequency (rank >>> RANK_LENGTH_BITS), fine (sense
  // position), headword length (the rest of rank), id. Frequency comes before
  // the sense position, so 什么 (first sense "what") beats 倽 (no frequency
  // data). All but the id are packed into one number, `key`, below 2^53.
  static key(c) {
    return ((((c.tier * 4 + (c.sub || 0)) * 0x10000 + (c.rank >>> RANK_LENGTH_BITS)) * 64 + (c.fine || 0)) * 256)
      + (c.rank & 0xFF);
  }

  static before(a, b) {
    return a.key < b.key || (a.key === b.key && a.id < b.id);
  }

  // How well an entry matched, without frequency and length.
  static quality(c) {
    return (c.tier * 4 + (c.sub || 0)) * 64 + (c.fine || 0);
  }

  // True when a candidate with this key and id cannot enter.
  rejects(key, id) {
    if (this.items.length < this.limit) return false;
    const worst = this.items[this.items.length - 1];
    return key > worst.key || (key === worst.key && id >= worst.id);
  }

  // Returns false when c did not enter (it is not better than the worst).
  push(c) {
    const key = TopK.key(c);
    if (this.rejects(key, c.id)) return false;
    const items = this.items;
    c.key = key;
    const prev = this.byId.get(c.id);
    if (prev) {
      if (TopK.quality(prev) <= TopK.quality(c)) return true;
      items.splice(items.indexOf(prev), 1);
    } else if (items.length >= this.limit) {
      this.byId.delete(items.pop().id);
    }
    let i = items.length;
    while (i > 0 && TopK.before(c, items[i - 1])) i--;
    items.splice(i, 0, c);
    this.byId.set(c.id, c);
    return true;
  }
}

// Inside the glossEqual tier: lib/normalize.js glossBucket, then frequency,
// then sense position (`fine`).
// English inflections that still count as the queried word ("shit" ->
// "shitty", "ban" -> "bans"), only for queries of at least this length;
// they follow the whole-word matches of the same tier.
const INFLECTIONS = new Set(['s', 'es', 'ed', 'ing', 'y', 'ty']);
const INFLECTION_MIN_LENGTH = 4;
// Order inside the word tier: a restricted gloss equal to the query, then
// the query as a whole word anywhere, then an inflected form of it.
const RESTRICTED_GLOSS_SUB = 0;
const WORD_SUB = 1;
const INFLECTED_SUB = 2;
// Postings run of key k: values[start[k]] .. values[start[k + 1]]. Every
// u32 section is read through subarray(), which a lazily loaded index
// (lib/index-format.js LazyU32) implements as a byte-range read; one call
// per run keeps that to a read per run.
function runOf(start, values, k) {
  const s = start.subarray(k, k + 2);
  return values.subarray(s[0], s[1]);
}

// The runs of keys lo .. hi - 1, contiguous in `values`.
function runsOf(start, values, lo, hi) {
  if (lo >= hi) return values.subarray(0, 0);
  const s = start.subarray(lo, hi + 1);
  return values.subarray(s[0], s[s.length - 1]);
}

// Text of item i of a blob (a string, or an object with slice(), see
// lib/index-format.js) cut by an offsets section.
function textAt(blob, offsets, i) {
  if (offsets instanceof Uint32Array) return blob.slice(offsets[i], offsets[i + 1]);
  const o = offsets.subarray(i, i + 2);
  return blob.slice(o[0], o[1]);
}

// Shortest query token that can be a whole-word or gloss match.
const MIN_WORD_QUERY = 2;
// Except "i" (the pronoun; no pinyin syllable is just "i").
const ONE_LETTER_WORDS = new Set(['i']);

export class Session {
  constructor(index) {
    this.index = index;
    // key name -> [{q, lo, exactHi, hi}] for successive prefixes of the query
    this.history = new Map();
    this.lastStats = null;
  }

  reset() {
    this.history.clear();
  }

  // Prefix range for q over the named key, bisecting inside the range of the
  // longest remembered prefix of q (or the full key when there is none).
  range(keyName, q) {
    const key = this.index.keys[keyName];
    let hist = this.history.get(keyName);
    if (!hist) this.history.set(keyName, (hist = []));
    let keep = 0;
    while (keep < hist.length && q.startsWith(hist[keep].q)) keep++;
    const base = keep > 0 ? hist[keep - 1] : null;
    hist.length = keep;
    const stats = this.lastStats;
    if (base && base.q === q) {
      stats.reused++;
      return base;
    }
    const lo = base ? base.lo : 0;
    const hi = base ? base.hi : key.length;
    stats.bisects++;
    stats.searched += hi - lo;
    const r = prefixRange(lo, hi, key.keyAt, q);
    const rec = { q, lo: r.lo, exactHi: r.exactHi, hi: r.hi };
    hist.push(rec);
    return rec;
  }

  // Entries whose key equals q (tier exactTier) or starts with it (prefixTier).
  collect(keyName, q, top, exactTier, prefixTier) {
    if (q === '' || !this.index.keys[keyName]) return;
    const { order } = this.index.keys[keyName];
    const { rank } = this.index;
    const r = this.range(keyName, q);
    if (this.rangesOnly) return;
    // The exact block is sorted by rank, so the first rejected one ends it.
    for (let i = r.lo; i < r.exactHi; i++) {
      if (!top.push({ id: order[i], tier: exactTier, rank: rank[order[i]], matchedOn: keyName })) break;
    }
    if (top.closedFor(prefixTier)) return;
    // Hot loop (a one-letter query scans most of the key): reject on the
    // packed key before building a candidate.
    for (let i = r.exactHi; i < r.hi; i++) {
      const id = order[i];
      if (top.rejects(TopK.key({ tier: prefixTier, rank: rank[id] }), id)) continue;
      top.push({ id, tier: prefixTier, rank: rank[id], matchedOn: keyName });
    }
  }

  // Definition words. tiers: {glossEqual, word, defPrefix}. A gloss equal
  // to the query (gloss table) is glossEqual, or word when the gloss is
  // capitalised; an entry with every token as a lowercase whole word is word
  // (an inflected form of a one-word query just after); anything else whose
  // words match the tokens (intersection, each token a prefix) is defPrefix.
  // Indexes without a gloss table have no glossEqual and no lowercase flag.
  //
  // Two passes so that a caller can collect other keys in between: the
  // whole-word pass (cheap: one postings run per token) and the prefix pass
  // (a union over every word with the prefix), which a full top-K of better
  // tiers skips. Returns the state the prefix pass needs, or null.
  collectDefinitionWords(q, top, tiers) {
    const tokens = definitionWords(q);
    if (tokens.length === 0) return null;
    const index = this.index;
    const { postStart, postings, rank } = index;
    const ranges = tokens.map((t) => this.range('words', t));
    if (ranges.some((r) => r.lo >= r.hi)) return null;
    const state = { tokens, ranges, tiers };
    // A one-letter token is a pinyin initial, an abbreviation or the "t" of
    // "isn't", not a word.
    if (tokens.some((t) => t.length < MIN_WORD_QUERY && !ONE_LETTER_WORDS.has(t))) return state;
    // The gloss range is taken even when no gloss can enter, so that the
    // next keystroke or a backspace finds it remembered.
    const g = index.keys.glosses ? this.range('glosses', tokens.join(' ')) : null;
    if (this.rangesOnly) return null;
    if (g && !top.closedFor(tiers.glossEqual)) {
      const { glossStart, glossPostings } = index;
      const run = runsOf(glossStart, glossPostings, g.lo, g.exactHi);
      for (let p = 0; p < run.length; p++) {
        const v = run[p];
        const id = v & GLOSS_ID_MASK;
        const score = v >>> GLOSS_SCORE_SHIFT;
        // Runs of older indexes are in another order: no early exit.
        const bucket = glossBucket(score);
        const fine = score & GLOSS_SENSE_MASK;
        if (score & GLOSS_CAPITALISED) {
          top.push({ id, tier: tiers.word, sub: WORD_SUB, rank: rank[id], matchedOn: 'definition' });
        } else if (bucket === GLOSS_RESTRICTED) {
          // In its own tier when that is the word tier, else the last bucket.
          const sub = tiers.restrictedGloss === tiers.glossEqual ? GLOSS_RESTRICTED : RESTRICTED_GLOSS_SUB;
          top.push({ id, tier: tiers.restrictedGloss, sub, fine, rank: rank[id], matchedOn: 'definition' });
        } else {
          top.push({ id, tier: tiers.glossEqual, sub: bucket, fine, rank: rank[id], matchedOn: 'definition' });
        }
      }
    }
    const flagged = Boolean(index.keys.glosses);
    const isWord = (v) => !flagged || (v & LOWERCASE_FLAG) !== 0;
    if (ranges.every((r) => r.exactHi > r.lo) && !top.closedFor(tiers.word)) {
      // Words are unique, so an exact range is one word. Walk the shortest
      // run (rank order) and require the other tokens through id sets.
      let driver = ranges[0];
      const runs = new Map(ranges.map((r) => [r, runOf(postStart, postings, r.lo)]));
      for (const r of ranges) if (runs.get(r).length < runs.get(driver).length) driver = r;
      const others = ranges.filter((r) => r !== driver).map((r) => {
        const ids = new Set();
        const run = runs.get(r);
        for (let p = 0; p < run.length; p++) if (isWord(run[p])) ids.add(run[p] & ID_MASK);
        return ids;
      });
      const run = runs.get(driver);
      for (let p = 0; p < run.length; p++) {
        const v = run[p];
        const id = v & ID_MASK;
        if (!isWord(v) || others.some((ids) => !ids.has(id))) continue;
        if (!top.push({ id, tier: tiers.word, sub: WORD_SUB, rank: rank[id], matchedOn: 'definition' })) break;
      }
    }
    if (tokens.length === 1 && tokens[0].length >= INFLECTION_MIN_LENGTH && !top.closedFor(tiers.word)) {
      const r = ranges[0];
      for (let w = r.exactHi; w < r.hi; w++) {
        if (!INFLECTIONS.has(index.keys.words.keyAt(w).slice(tokens[0].length))) continue;
        const run = runOf(postStart, postings, w);
        for (let p = 0; p < run.length; p++) {
          const v = run[p];
          if (!isWord(v)) continue;
          const id = v & ID_MASK;
          if (!top.push({ id, tier: tiers.word, sub: INFLECTED_SUB, rank: rank[id], matchedOn: 'definition' })) break;
        }
      }
    }
    return state;
  }

  collectDefinitionPrefixes(state, top) {
    if (!state || this.rangesOnly || top.closedFor(state.tiers.defPrefix)) return;
    const { tokens, ranges, tiers } = state;
    const { postStart, postings, rank } = this.index;
    const first = ranges[0];
    let seen = new Set();
    const firstRuns = runsOf(postStart, postings, first.lo, first.hi);
    for (let p = 0; p < firstRuns.length; p++) seen.add(firstRuns[p] & ID_MASK);
    for (let t = 1; t < tokens.length; t++) {
      const r = ranges[t];
      const matched = new Set();
      const runs = runsOf(postStart, postings, r.lo, r.hi);
      for (let p = 0; p < runs.length; p++) {
        const id = runs[p] & ID_MASK;
        if (seen.has(id)) matched.add(id);
      }
      seen = matched;
    }
    for (const id of seen) top.push({ id, tier: tiers.defPrefix, rank: rank[id], matchedOn: 'definition' });
  }

  collectDefinition(q, top, tiers) {
    this.collectDefinitionPrefixes(this.collectDefinitionWords(q, top, tiers), top);
  }

  // Romanization (pinyin) key for an ASCII query: toned when it has a tone
  // digit and the index has a toned key, bare otherwise.
  collectRomanization(q, top, tiers) {
    const kf = this.index.keyFns;
    const toned = this.index.keys.pinyinToned && /[0-9]/.test(q);
    const key = toned ? kf.romanizationToned(q) : kf.romanizationBare(q);
    this.collect(toned ? 'pinyinToned' : 'pinyinBare', key, top, tiers.romanExact, tiers.romanPrefix);
  }

  search(query, opts) {
    const index = this.index;
    return this.candidates(query, opts).map((c) => index.entry(c.id, c.matchedOn));
  }

  // search() for an index opened with lib/lazy-index.js openIndexLazy,
  // whose sections are read asynchronously: the key ranges first (bisects
  // only), then the ranked candidates, then the entries of the results, each
  // step run again after loading the bytes it was missing (NeedBytes). Plain
  // search() on any other index.
  async searchAsync(query, opts) {
    const index = this.index;
    if (!index.blockCache) return this.search(query, opts);
    await index.retry(() => this.candidates(query, { ...opts, rangesOnly: true }));
    const found = await index.retry(() => this.candidates(query, opts));
    return index.entriesAsync(found);
  }

  // Ranked [{id, tier, matchedOn, ...}] without the entry fields;
  // rangesOnly: only take the key ranges (the bisects), find nothing.
  candidates(query, { limit = DEFAULT_LIMIT, rangesOnly = false } = {}) {
    const stats = (this.lastStats = { bisects: 0, reused: 0, searched: 0, mode: null });
    const q = query.trim();
    if (q === '') return [];
    this.rangesOnly = rangesOnly;
    try {
      return this.collectAll(q, limit);
    } finally {
      this.rangesOnly = false;
    }
  }

  collectAll(q, limit) {
    const stats = this.lastStats;
    const top = new TopK(limit);
    const index = this.index;
    const roman = ROMANIZATION_PREFIXES.find((p) => q.startsWith(p));
    if (q.startsWith(DEFINITION_PREFIX)) {
      stats.mode = 'definition';
      this.collectDefinition(q.slice(DEFINITION_PREFIX.length), top, DEFINITION_ONLY);
    } else if (roman) {
      stats.mode = 'pinyin';
      this.collectRomanization(q.slice(roman.length).trim(), top, ROMANIZATION_ONLY);
    } else if (!index.isChinese) {
      stats.mode = 'mixed';
      const hq = index.keyFns.headword(q);
      this.collect('simp', hq, top, GENERIC.headExact, GENERIC.headPrefix);
      this.collect('trad', hq, top, GENERIC.formExact, GENERIC.formPrefix);
      this.collect('forms', hq, top, GENERIC.formExact, GENERIC.formPrefix);
      const words = this.collectDefinitionWords(q, top, GENERIC);
      this.collectRomanization(q, top, GENERIC);
      this.collectDefinitionPrefixes(words, top);
    } else if (hasCjk(q)) {
      stats.mode = 'headword';
      this.collect('simp', q, top, HEADWORD.exact, HEADWORD.prefix);
      this.collect('trad', q, top, HEADWORD.exact, HEADWORD.prefix);
    } else if (looksLikePinyin(q)) {
      // Tone digits, u: and ü only occur in pinyin; letters and spaces may be either.
      stats.mode = ENGLISH_OR_PINYIN_RE.test(q) ? 'mixed' : 'pinyin';
      const words = stats.mode === 'mixed' ? this.collectDefinitionWords(q, top, ZH_ASCII) : null;
      this.collectRomanization(q, top, ZH_ASCII);
      this.collectDefinitionPrefixes(words, top);
    } else {
      stats.mode = 'definition';
      this.collectDefinition(q, top, DEFINITION_ONLY);
    }
    return top.items;
  }
}

export class Dictionary {
  // header: the index file's JSON header (language, source, keys); an empty
  // object means an index written before those fields existed (Chinese).
  constructor(sections, header = {}) {
    const { blob, fieldOffsets, rank, wordsBlob, wordOffsets, postStart, postings } = sections;
    this.blob = blob;
    this.fieldOffsets = fieldOffsets;
    this.rank = rank;
    this.size = (fieldOffsets.length - 1) / FIELDS_PER_ENTRY;
    this.wordsBlob = wordsBlob;
    this.wordOffsets = wordOffsets;
    this.postStart = postStart;
    this.postings = postings;
    this.audio = sections.audioEntries === undefined ? null : {
      names: sections.audioNameBlob,
      nameOffsets: sections.audioNameOffsets,
      entries: sections.audioEntries,
      refStart: sections.audioRefStart,
      refs: sections.audioRefs,
    };
    this.details = null;
    this.attachDetails(sections, header);
    this.glossStart = sections.glossStart || null;
    this.glossPostings = sections.glossPostings || null;
    this.language = header.language || DEFAULT_LANGUAGE;
    this.source = header.source || null;
    this.entryUrl = header.entryUrl || null;
    const kf = keyFunctions(header.keys);
    this.keyFns = kf;
    // Chinese scheme: CJK queries go to headwords, ASCII ones to pinyin and
    // English. Any other index searches every key for every query.
    this.isChinese = kf.scheme.romanization === 'pinyin';
    const entryKey = (order, derive) => (order ? { order, length: order.length, keyAt: (i) => derive(order[i]) } : null);
    this.keys = {
      simp: entryKey(sections.orderSimp, (id) => kf.headword(this.field(id, FIELD_SIMP))),
      trad: entryKey(sections.orderTrad, (id) => kf.headword(this.field(id, FIELD_TRAD))),
      // Repeatable alternative forms (build-index.js formTable): stored
      // in key order, so formEntry doubles as the order array.
      forms: sections.formEntry === undefined ? null : {
        order: sections.formEntry,
        length: sections.formEntry.length,
        keyAt: (i) => kf.headword(textAt(sections.formBlob, sections.formOffsets, i)),
      },
      pinyinToned: entryKey(sections.orderPinyinToned, (id) => kf.romanizationToned(this.field(id, FIELD_PINYIN))),
      pinyinBare: entryKey(sections.orderPinyinBare, (id) => kf.romanizationBare(this.field(id, FIELD_PINYIN))),
      words: { order: null, length: wordOffsets.length - 1, keyAt: (w) => textAt(wordsBlob, wordOffsets, w) },
      glosses: sections.glossBlob === undefined ? null : {
        order: null,
        length: sections.glossOffsets.length - 1,
        keyAt: (k) => textAt(sections.glossBlob, sections.glossOffsets, k),
      },
    };
    this.defaultSession = new Session(this);
  }

  field(id, f) {
    return textAt(this.blob, this.fieldOffsets, id * FIELDS_PER_ENTRY + f);
  }

  // An index with an entryUrl adds `url`, the entry's page.
  entry(id, matchedOn) {
    const e = {
      id,
      simp: this.field(id, FIELD_SIMP),
      trad: this.field(id, FIELD_TRAD),
      pinyin: this.field(id, FIELD_PINYIN),
      definition: this.field(id, FIELD_DEFINITION),
      audio: this.audioOf(id),
      matchedOn,
    };
    if (this.entryUrl) e.url = entryUrlOf(this.entryUrl, e.simp);
    return e;
  }

  // Entries whose simplified or traditional headword contains `text` (and
  // is longer than it), most frequent first: the words a character is part
  // of. A linear scan (about 200k headwords for Chinese), so meant for an
  // in-memory index and one call per page.
  containing(text, limit = 20) {
    const found = [];
    for (let id = 0; id < this.size; id++) {
      const simp = this.field(id, FIELD_SIMP);
      if (simp === text) continue;
      if (simp.indexOf(text) >= 0 || this.field(id, FIELD_TRAD).indexOf(text) >= 0) found.push(id);
    }
    found.sort((a, b) => this.rank[a] - this.rank[b] || a - b);
    return found.slice(0, limit).map((id) => this.entry(id, 'containing'));
  }

  // Uses the details sections of `sections` (an index with embedded
  // details, or a .details sidecar file: header kind 'details'); sections
  // without them leave the dictionary as it is. A sidecar must have been
  // written for this index (same entry count).
  attachDetails(sections, header = {}) {
    if (sections.detailsData === undefined) return false;
    if (header.kind === 'details' && header.entries !== this.size) {
      throw new Error(`details file for ${header.entries} entries, index has ${this.size}`);
    }
    this.details = {
      blockSize: (header.details && header.details.blockSize) || DETAILS_BLOCK,
      start: sections.detailsBlockStart,
      bytes: sections.detailsBlockBytes,
      data: sections.detailsData,
      cache: new Map(),
    };
    return true;
  }

  // The entry's details object (schema: sources/wiktionary-details.js), or
  // null when it has none or the index has no details. Inflates the entry's
  // block (DETAILS_BLOCK entries) through this.inflate and keeps the last
  // few blocks.
  async getDetails(id) {
    const d = this.details;
    if (!d || id < 0 || id >= this.size) return null;
    const b = Math.floor(id / d.blockSize);
    let list = d.cache.get(b);
    if (!list) {
      const [start, end] = d.start.subarray(b, b + 2);
      const words = d.data.subarray(start, end);
      const bytes = new Uint8Array(words.buffer, words.byteOffset, d.bytes.subarray(b, b + 1)[0]);
      list = JSON.parse(await this.inflate(bytes));
      d.cache.set(b, list);
      if (d.cache.size > DETAILS_CACHE_BLOCKS) d.cache.delete(d.cache.keys().next().value);
    }
    return list[id - b * d.blockSize] || null;
  }

  // gzip bytes -> text (or a Promise of it), supplied by the host: lookup.js
  // sets zlib; a page sets DecompressionStream('gzip') where it exists and
  // web/inflate.js gunzip otherwise.
  inflate() {
    throw new Error('Dictionary.inflate is not set: assign a gzip decoder before getDetails()');
  }

  // Wikimedia Commons file names of the entry's pronunciations (possibly
  // none); AUDIO_URL_PREFIX + encodeURIComponent(name) plays one.
  audioOf(id) {
    const a = this.audio;
    if (!a) return [];
    let lo = 0;
    let hi = a.entries.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (a.entries[mid] < id) lo = mid + 1;
      else hi = mid;
    }
    if (lo === a.entries.length || a.entries[lo] !== id) return [];
    const out = [];
    for (let r = a.refStart[lo]; r < a.refStart[lo + 1]; r++) {
      const k = a.refs[r];
      out.push(a.names.slice(a.nameOffsets[k], a.nameOffsets[k + 1]));
    }
    return out;
  }

  newSession() {
    return new Session(this);
  }

  search(query, opts) {
    return this.defaultSession.search(query, opts);
  }

  searchAsync(query, opts) {
    return this.defaultSession.searchAsync(query, opts);
  }

  // Runs fn() until it does not throw NeedBytes, loading the missing range
  // through this.blockCache in between (an index from openIndexLazy).
  async retry(fn) {
    for (;;) {
      try {
        return fn();
      } catch (err) {
        if (!(err instanceof NeedBytes) || !this.blockCache) throw err;
        await this.blockCache.load(err.offset, err.length);
      }
    }
  }

  // Entries of search candidates, loading their fields in two parallel
  // rounds (offsets, then text) when the sections are read asynchronously.
  async entriesAsync(found) {
    const offsets = this.fieldOffsets;
    if (typeof offsets.load === 'function') {
      await Promise.all(found.map((c) => offsets.load(c.id * FIELDS_PER_ENTRY, (c.id + 1) * FIELDS_PER_ENTRY + 1)));
    }
    if (typeof this.blob.load === 'function') {
      await Promise.all(found.map((c) => this.retry(() => {
        const o = offsets.subarray(c.id * FIELDS_PER_ENTRY, (c.id + 1) * FIELDS_PER_ENTRY + 1);
        return this.blob.load(o[0], o[o.length - 1]);
      })));
    }
    return this.retry(() => found.map((c) => this.entry(c.id, c.matchedOn)));
  }
}

// bytes: Uint8Array (a Node Buffer is one) or ArrayBuffer of an index file.
// options.details: the bytes of the index's .details sidecar file (an
// index with embedded details needs none; without either getDetails
// returns null).
export function openIndex(bytes, options = {}) {
  const { header, sections } = deserializeIndexWithHeader(bytes);
  const d = new Dictionary(sections, header);
  if (options.details) {
    const side = deserializeIndexWithHeader(options.details);
    d.attachDetails(side.sections, side.header);
  }
  return d;
}
