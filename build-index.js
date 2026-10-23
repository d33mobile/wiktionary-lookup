#!/usr/bin/env node
// Usage: node build-index.js SOURCE FILE OUT [--wordfreq LIST]
// --wordfreq passes a wordfreq list (lib/wordfreq.js) to sources that rank
// by frequency (wiktionary-zh, wiktionary).
// SOURCE is a module name under sources/ (e.g. cedict-text) or a path to a
// module exporting `async function* entries(path, info)`. A source may fill
// the object `info` while it runs with index header metadata: `language`
// ({code, name, script, hasRomanization}), `source` and `keys` (see
// lib/index-format.js); `keys` also selects the key derivation used here.
import { writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  serializeIndex, LOWERCASE_FLAG, ID_MASK, GLOSS_SCORE_SHIFT, GLOSS_ID_MASK as GLOSS_ID_LIMIT,
} from './lib/index-format.js';
import {
  definitionTokens, glossKeys, glossBucket, codePointLength, keyFunctions, GLOSS_CAPITALISED, GLOSS_SENSE_MASK,
} from './lib/normalize.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIELDS_PER_ENTRY = 4;
const MAX_HEADWORD_LENGTH = 0xFF;
const MAX_FREQUENCY_RANK = 0xFFFF;
// rank = frequency rank << RANK_LENGTH_BITS | headword length (lib/engine.js
// compares the two parts separately). Indexes written before frequencies
// were used have length << 16 | 0, which still orders by length first.
const RANK_LENGTH_BITS = 8;


function compareStrings(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

export async function loadSource(name) {
  const spec = /[/\\]|\.m?js$/.test(name) ? resolve(name) : resolve(HERE, 'sources', `${name}.js`);
  const mod = await import(pathToFileURL(spec).href);
  if (typeof mod.entries !== 'function') throw new Error(`${spec} does not export entries()`);
  return mod;
}

// Frequency hook: entries may carry a numeric `freq` (higher = more common,
// e.g. a Zipf frequency). Equal values share a rank; ranks are dense in
// [0, MAX_FREQUENCY_RANK), 0 the most frequent, and entries without `freq`
// get MAX_FREQUENCY_RANK, after every entry with one. Without frequency data
// (CC-CEDICT, most Wiktionary languages) every entry gets MAX_FREQUENCY_RANK
// and headword length decides.
export function frequencyRanks(freqs) {
  const ranks = new Uint16Array(freqs.length).fill(MAX_FREQUENCY_RANK);
  const values = [...new Set(freqs.filter(Number.isFinite))].sort((a, b) => b - a);
  const rankOf = new Map(values.map((v, r) => [v, Math.min(r, MAX_FREQUENCY_RANK - 1)]));
  for (let i = 0; i < freqs.length; i++) if (Number.isFinite(freqs[i])) ranks[i] = rankOf.get(freqs[i]);
  return ranks;
}

function sortedOrder(keys, rank) {
  const order = new Uint32Array(keys.length);
  for (let i = 0; i < order.length; i++) order[i] = i;
  order.sort((a, b) => compareStrings(keys[a], keys[b]) || rank[a] - rank[b] || a - b);
  return order;
}

// keys: {headword, romanization} key schemes (lib/normalize.js keyFunctions);
// may also be given later through info.keys by the source itself, since it
// is read after the entries are consumed. In a 'fold' romanization scheme the
// toned and bare keys are the same, so only orderPinyinBare is written, and
// neither is written when no entry has a romanization.
export async function buildIndex(entryIterable, info = {}) {
  const simp = [];
  const trad = [];
  const pinyin = [];
  const definition = [];
  const freqs = [];
  const audio = [];
  const details = new DetailsWriter();
  const forms = [];
  for await (const e of entryIterable) {
    simp.push(e.simp);
    trad.push(e.trad ?? e.simp);
    pinyin.push(e.pinyin);
    definition.push(e.definition);
    freqs.push(e.freq);
    audio.push(Array.isArray(e.audio) ? e.audio : []);
    details.add(typeof e.details === 'string' ? e.details : e.details ? JSON.stringify(e.details) : null);
    forms.push(Array.isArray(e.forms) ? e.forms : []);
  }
  const n = simp.length;
  const kf = keyFunctions(info.keys);

  const rankFreq = frequencyRanks(freqs);
  const rank = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    rank[i] = (rankFreq[i] << RANK_LENGTH_BITS) | Math.min(codePointLength(simp[i]), MAX_HEADWORD_LENGTH);
  }

  const fieldOffsets = new Uint32Array(n * FIELDS_PER_ENTRY + 1);
  const parts = [];
  let pos = 0;
  for (let i = 0; i < n; i++) {
    const fields = [simp[i], trad[i], pinyin[i], definition[i]];
    for (let f = 0; f < FIELDS_PER_ENTRY; f++) {
      fieldOffsets[i * FIELDS_PER_ENTRY + f] = pos;
      parts.push(fields[f]);
      pos += fields[f].length;
    }
  }
  fieldOffsets[n * FIELDS_PER_ENTRY] = pos;

  // Definition words: postings carry LOWERCASE_FLAG when the entry has the
  // word in lower case at least once (an English word, not only a name).
  const wordToIds = new Map();
  for (let i = 0; i < n; i++) {
    const lower = new Map();
    for (const t of definitionTokens(definition[i])) lower.set(t.word, lower.get(t.word) || t.lower);
    for (const [w, isLower] of lower) {
      let ids = wordToIds.get(w);
      if (!ids) wordToIds.set(w, (ids = []));
      ids.push(isLower ? (i | LOWERCASE_FLAG) >>> 0 : i);
    }
  }
  const words = postingTable(wordToIds, (v) => rank[v & ID_MASK], (v) => v & ID_MASK);

  // Gloss keys (lib/normalize.js glossKeys): postings are id | score << 24.
  if (n > GLOSS_ID_LIMIT) throw new Error(`${n} entries, the gloss table holds at most ${GLOSS_ID_LIMIT}`);
  const glossToIds = new Map();
  for (let i = 0; i < n; i++) {
    for (const [key, score] of glossKeys(definition[i])) {
      let ids = glossToIds.get(key);
      if (!ids) glossToIds.set(key, (ids = []));
      ids.push((i | (score << GLOSS_SCORE_SHIFT)) >>> 0);
    }
  }
  // Run order = the engine's order: capitalised glosses (word tier) last,
  // then quality bucket, frequency, sense position, headword length.
  const glossOrder = (v) => {
    const score = v >>> GLOSS_SCORE_SHIFT;
    const r = rank[v & GLOSS_ID_LIMIT];
    if (score & GLOSS_CAPITALISED) return 3 * 2 ** 40 + r;
    return ((glossBucket(score) * 0x10000 + (r >>> RANK_LENGTH_BITS)) * 0x100 + (score & GLOSS_SENSE_MASK)) * 0x100 + (r & 0xFF);
  };
  const glosses = postingTable(glossToIds, glossOrder, (v) => v & GLOSS_ID_LIMIT);

  const romanized = kf.scheme.romanization === 'pinyin' || pinyin.some((p) => p !== '');
  const sections = {
    blob: parts.join(''),
    fieldOffsets,
    rank,
    orderSimp: sortedOrder(simp.map(kf.headword), rank),
  };
  // No alternative form anywhere (Wikipedia titles): no key to search.
  if (trad.some((t) => t !== '')) sections.orderTrad = sortedOrder(trad.map(kf.headword), rank);
  if (romanized && kf.scheme.romanization === 'pinyin') sections.orderPinyinToned = sortedOrder(pinyin.map(kf.romanizationToned), rank);
  if (romanized) sections.orderPinyinBare = sortedOrder(pinyin.map(kf.romanizationBare), rank);
  const out = {
    ...sections,
    wordsBlob: words.blob,
    wordOffsets: words.offsets,
    postStart: words.start,
    postings: words.postings,
    glossBlob: glosses.blob,
    glossOffsets: glosses.offsets,
    glossStart: glosses.start,
    glossPostings: glosses.postings,
    ...audioTable(audio),
    ...formTable(forms, kf.headword, rank),
    ...details.sections(),
  };
  if (out.detailsData) info.details = { format: 'gzip-json', blockSize: details.blockSize, jsonBytes: details.jsonBytes, entries: details.count };
  if (info.textOffsets === 'bytes') {
    for (const [blob, offsets] of TEXT_TABLES) if (out[blob] !== undefined) out[offsets] = byteOffsets(out[blob], out[offsets]);
  }
  return out;
}

// Text sections and the offsets that cut them (lib/index-format.js
// textOffsets).
const TEXT_TABLES = [
  ['blob', 'fieldOffsets'], ['wordsBlob', 'wordOffsets'], ['glossBlob', 'glossOffsets'], ['formBlob', 'formOffsets'],
  ['audioNameBlob', 'audioNameOffsets'],
];

// Bytes the UTF-8 encoding of text[start, end) takes (a lone surrogate
// becomes U+FFFD, three bytes, as in TextEncoder).
function utf8Length(text, start, end) {
  let n = 0;
  for (let i = start; i < end; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) {
      n += 1;
    } else if (c < 0x800) {
      n += 2;
    } else if (c >= 0xD800 && c <= 0xDBFF && i + 1 < end && (text.charCodeAt(i + 1) & 0xFC00) === 0xDC00) {
      n += 4;
      i++;
    } else {
      n += 3;
    }
  }
  return n;
}

// Code-unit offsets into `text` -> UTF-8 byte offsets of the same cuts.
export function byteOffsets(text, offsets) {
  const out = new Uint32Array(offsets.length);
  for (let k = 1; k < offsets.length; k++) {
    const bytes = out[k - 1] + utf8Length(text, offsets[k - 1], offsets[k]);
    if (bytes > 0xFFFFFFFF) throw new Error('text section over 4 GiB');
    out[k] = bytes;
  }
  return out;
}

// Alternative forms beyond `trad`, any number per entry (Wikipedia
// redirects): sorted by headword key, then entry rank and id, so position i
// is both the sort order and the form's index. Nothing is written when no
// entry has one.
//   formBlob    utf8  the forms concatenated in that order
//   formOffsets u32   F+1 code-unit offsets into formBlob
//   formEntry   u32   entry id of the form at each position
export function formTable(forms, headwordKey, rank) {
  let total = 0;
  for (const f of forms) total += f.length;
  if (total === 0) return {};
  const text = new Array(total);
  const key = new Array(total);
  const entry = new Uint32Array(total);
  for (let i = 0, k = 0; i < forms.length; i++) {
    for (const f of forms[i]) {
      text[k] = f;
      key[k] = headwordKey(f);
      entry[k++] = i;
    }
  }
  const order = new Uint32Array(total);
  for (let k = 0; k < total; k++) order[k] = k;
  order.sort((a, b) => compareStrings(key[a], key[b]) || rank[entry[a]] - rank[entry[b]] || entry[a] - entry[b]
    || compareStrings(text[a], text[b]));
  const offsets = new Uint32Array(total + 1);
  const formEntry = new Uint32Array(total);
  const parts = new Array(total);
  for (let p = 0, pos = 0; p < total; p++) {
    const k = order[p];
    offsets[p] = pos;
    parts[p] = text[k];
    pos += text[k].length;
    offsets[p + 1] = pos;
    formEntry[p] = entry[k];
  }
  return { formBlob: parts.join(''), formOffsets: offsets, formEntry };
}

// Pronunciation files (Wikimedia Commons file names) of the entries that
// have any: a table of unique names and, for the entries with audio in id
// order, a run of name indexes each. Nothing is written when no entry has
// audio, and an index without these sections has none.
//   audioNameBlob    utf8  unique names concatenated
//   audioNameOffsets u32   A+1 offsets into audioNameBlob
//   audioEntries     u32   ids of the entries with audio, ascending
//   audioRefStart    u32   M+1 offsets into audioRefs
//   audioRefs        u32   name indexes per entry, in the source's order
export function audioTable(audio) {
  const nameIndex = new Map();
  const entries = [];
  const refs = [];
  const refStart = [0];
  for (let i = 0; i < audio.length; i++) {
    if (audio[i].length === 0) continue;
    entries.push(i);
    for (const name of audio[i]) {
      if (!nameIndex.has(name)) nameIndex.set(name, nameIndex.size);
      refs.push(nameIndex.get(name));
    }
    refStart.push(refs.length);
  }
  if (entries.length === 0) return {};
  const names = [...nameIndex.keys()];
  const offsets = new Uint32Array(names.length + 1);
  for (let k = 0, pos = 0; k < names.length; k++) {
    offsets[k] = pos;
    pos += names[k].length;
    offsets[k + 1] = pos;
  }
  return {
    audioNameBlob: names.join(''),
    audioNameOffsets: offsets,
    audioEntries: Uint32Array.from(entries),
    audioRefStart: Uint32Array.from(refStart),
    audioRefs: Uint32Array.from(refs),
  };
}

// Sorted unique keys concatenated (blob, offsets) and one postings run per
// key (start, postings), each run sorted by order(value), then id(value).
function postingTable(keyToValues, order, id) {
  const keys = [...keyToValues.keys()].sort(compareStrings);
  const offsets = new Uint32Array(keys.length + 1);
  const start = new Uint32Array(keys.length + 1);
  let keyPos = 0;
  let postPos = 0;
  for (let k = 0; k < keys.length; k++) {
    offsets[k] = keyPos;
    start[k] = postPos;
    keyPos += keys[k].length;
    postPos += keyToValues.get(keys[k]).length;
  }
  offsets[keys.length] = keyPos;
  start[keys.length] = postPos;
  const postings = new Uint32Array(postPos);
  for (let k = 0; k < keys.length; k++) {
    const values = keyToValues.get(keys[k]);
    values.sort((a, b) => order(a) - order(b) || id(a) - id(b));
    postings.set(values, start[k]);
  }
  return { blob: keys.join(''), offsets, start, postings };
}

async function main(argv) {
  const options = {};
  const wf = argv.indexOf('--wordfreq');
  if (wf >= 0) [, options.wordfreq] = argv.splice(wf, 2);
  let detailsMode = 'sidecar';
  const dm = argv.indexOf('--details');
  if (dm >= 0) [, detailsMode] = argv.splice(dm, 2);
  if (argv.length !== 3 || !DETAILS_MODES.includes(detailsMode)) {
    console.error('usage: build-index.js SOURCE FILE OUT [--wordfreq LIST] [--details sidecar|embedded|none]');
    process.exit(2);
  }
  const [sourceName, file, out] = argv;
  const t0 = performance.now();
  const source = await loadSource(sourceName);
  const info = {};
  if (detailsMode === 'none') options.details = false;
  const sections = await buildIndex(source.entries(file, info, options), info);
  const written = await writeIndexFiles(sections, info, out, detailsMode);
  const entries = (sections.fieldOffsets.length - 1) / FIELDS_PER_ENTRY;
  console.log(`${entries} entries, ${sections.wordOffsets.length - 1} definition words, ${sections.postings.length} postings`);
  for (const w of written) console.log(`wrote ${w.path} (${(w.bytes / 1024 / 1024).toFixed(1)} MiB)`);
  console.log(`in ${(performance.now() - t0).toFixed(0)} ms`);
}


// Where the details go: 'sidecar' (default) a separate OUT.details file next
// to OUT.idx, so the index stays small and the details are an optional
// download; 'embedded' inside the index; 'none' not at all.
export const DETAILS_MODES = ['sidecar', 'embedded', 'none'];
const DETAILS_SECTIONS = ['detailsBlockStart', 'detailsBlockBytes', 'detailsData'];

// sidecar file of out: x.idx -> x.details (else out + '.details').
export function detailsPath(out) {
  return out.endsWith('.idx') ? `${out.slice(0, -4)}.details` : `${out}.details`;
}

// -> {base: {sections, meta}, details: {sections, meta} | null}. The sidecar
// is a file of the same container with header kind 'details', the entry
// count it belongs to and the details metadata; the base index loses its
// details sections and its `details` header field.
export function splitDetails(sections, meta) {
  if (sections.detailsData === undefined) return { base: { sections, meta }, details: null };
  const base = { ...sections };
  const side = {};
  for (const name of DETAILS_SECTIONS) {
    side[name] = sections[name];
    delete base[name];
  }
  const { details, ...baseMeta } = meta;
  const entries = (sections.fieldOffsets.length - 1) / FIELDS_PER_ENTRY;
  return { base: { sections: base, meta: baseMeta }, details: { sections: side, meta: { kind: 'details', entries, details } } };
}

// Writes out (and its sidecar in 'sidecar' mode); -> [{path, bytes, kind}].
export async function writeIndexFiles(sections, meta, out, mode = 'sidecar') {
  if (mode === 'embedded' || mode === 'none') {
    const bytes = serializeIndex(sections, meta);
    await writeFile(out, bytes);
    return [{ path: out, bytes: bytes.length, kind: 'index' }];
  }
  const { base, details } = splitDetails(sections, meta);
  const baseBytes = serializeIndex(base.sections, base.meta);
  await writeFile(out, baseBytes);
  const written = [{ path: out, bytes: baseBytes.length, kind: 'index' }];
  if (details) {
    const sideBytes = serializeIndex(details.sections, details.meta);
    await writeFile(detailsPath(out), sideBytes);
    written.push({ path: detailsPath(out), bytes: sideBytes.length, kind: 'details' });
  }
  return written;
}

// Details (an optional JSON object per entry, sources/wiktionary-details.js),
// compressed in blocks of DETAILS_BLOCK entries so that a detail view
// inflates one small block. A block is the gzip of a JSON array with one
// element per entry id (null: no details). Sections, written only when some
// entry has details (lib/engine.js getDetails reads them):
//   detailsBlockStart u32  B+1 offsets into detailsData in 4-byte words
//                          (every block starts 4-byte aligned)
//   detailsBlockBytes u32  B byte lengths of the gzip members
//   detailsData       u32  the blocks, zero padded
export const DETAILS_BLOCK = 64;
export class DetailsWriter {
  constructor(blockSize = DETAILS_BLOCK) {
    this.blockSize = blockSize;
    this.current = [];
    this.blocks = [];
    this.any = false;
    this.jsonBytes = 0;
    this.count = 0;
  }

  add(json) {
    if (json !== null) {
      this.any = true;
      this.count++;
      this.jsonBytes += Buffer.byteLength(json);
    }
    this.current.push(json === null ? 'null' : json);
    if (this.current.length === this.blockSize) this.flush();
  }

  flush() {
    if (this.current.length === 0) return;
    this.blocks.push(gzipSync(`[${this.current.join(',')}]`, { level: 9 }));
    this.current = [];
  }

  sections() {
    this.flush();
    if (!this.any) return {};
    const start = new Uint32Array(this.blocks.length + 1);
    const bytes = new Uint32Array(this.blocks.length);
    let words = 0;
    this.blocks.forEach((b, i) => {
      start[i] = words;
      bytes[i] = b.length;
      words += Math.ceil(b.length / 4);
    });
    start[this.blocks.length] = words;
    const data = new Uint8Array(words * 4);
    this.blocks.forEach((b, i) => data.set(b, start[i] * 4));
    return { detailsBlockStart: start, detailsBlockBytes: bytes, detailsData: new Uint32Array(data.buffer) };
  }
}

// Last, so that every top-level declaration above is initialised.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((err) => { console.error(err); process.exit(1); });
}
