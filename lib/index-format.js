// Container for the persisted index: a magic string, a 4-byte little-endian
// header length, a JSON header listing sections, then the sections themselves,
// each 4-byte aligned so typed arrays can be views on the file buffer.
//
// Sections:
//   blob         utf8   all entry fields concatenated (simp, trad, pinyin,
//                       definition per entry, in entry order)
//   fieldOffsets u32    4*N+1 code-unit offsets into the decoded blob
//   rank         u32    per entry, lower is better (headword length, frequency)
//   order<Key>   u32    entry ids sorted by that key
//   wordsBlob    utf8   unique definition words concatenated, sorted
//   wordOffsets  u32    W+1 code-unit offsets into wordsBlob
//   postStart    u32    W+1 offsets into postings
//   postings     u32    entry ids per word, each run sorted by rank; when the
//                       index has a gloss table the top bit (LOWERCASE_FLAG)
//                       marks entries that have the word in lower case
//   glossBlob    utf8   unique gloss keys (lib/normalize.js glossKeys), sorted
//   glossOffsets u32    G+1 code-unit offsets into glossBlob
//   glossStart   u32    G+1 offsets into glossPostings
//   glossPostings u32   id | score << GLOSS_SCORE_SHIFT per gloss, each run
//                       sorted by score, then rank
// The gloss table and the flag were added later: an index without
// glossBlob has plain ids in postings.
//
// The JSON header carries {version, sections} plus optional metadata written
// by the builder (all optional; files written before they existed lack them):
//   language  {code, name, script, hasRomanization}  e.g. {code: 'de',
//             name: 'German', script: 'Latn', hasRomanization: false}
//   source    {name, url, extracted, dumpDate}         where the data came from
//   keys      {headword: 'exact'|'fold', romanization: 'pinyin'|'fold'}
//             how lib/normalize.js derives the sort keys (see keyFunctions)
//   textOffsets 'bytes': every *Offsets section counts UTF-8 bytes of its
//             blob instead of UTF-16 code units of the decoded string, so
//             a field can be read by byte range without decoding the blob.
//             The blob sections are then returned as objects with
//             slice(start, end) (ByteText, LazyText) instead of strings.
//   entryUrl  a URL with "{title}" standing for an entry's headword
//             (Wikipedia: https://en.wikipedia.org/wiki/{title})
//
// Optional sections of a few sources: the form table (formBlob,
// formOffsets, formEntry; build-index.js formTable) and the audio table.
//
// No Node APIs: the module works on Uint8Array/ArrayBuffer so the same code
// loads the index in a browser (fetch -> arrayBuffer) and in Node (readFile,
// whose Buffer is a Uint8Array). Reading a file is the caller's job.

const MAGIC = new TextEncoder().encode('PLKIDX1\n');
const ALIGN = 4;
const LENGTH_BYTES = 4;
export const FORMAT_VERSION = 1;
export const LOWERCASE_FLAG = 0x80000000;
export const ID_MASK = 0x7FFFFFFF;
export const GLOSS_SCORE_SHIFT = 24;
export const GLOSS_ID_MASK = 0xFFFFFF;

function padTo(n, align) {
  return (align - (n % align)) % align;
}

const TEXT_DECODER = new TextDecoder();

// UTF-8 text addressed by byte offsets, held in memory.
export class ByteText {
  constructor(bytes) {
    this.bytes = bytes;
    this.length = bytes.length;
  }

  slice(start, end) {
    return TEXT_DECODER.decode(this.bytes.subarray(start, end));
  }
}

// read(offset, length) -> Uint8Array: a synchronous byte-range reader over
// the index file (Node: fs.readSync; Android: a native file read through
// the WebView bridge).
function readU32(read, offset, length) {
  const bytes = read(offset, length * 4);
  return bytes.byteOffset % ALIGN === 0
    ? new Uint32Array(bytes.buffer, bytes.byteOffset, length)
    : new Uint32Array(bytes.slice().buffer, 0, length);
}

// A u32 section left on disk: subarray(start, end) reads that range.
// `load` (optional, lib/lazy-index.js): async (offset, length) that makes a
// range readable by `read`; load(start, end) then prepares subarray(start, end).
export class LazyU32 {
  constructor(read, offset, length, load = null) {
    this.read = read;
    this.offset = offset;
    this.length = length;
    this.loader = load;
  }

  load(start, end) {
    const s = Math.max(0, Math.min(start, this.length));
    const e = Math.max(s, Math.min(end, this.length));
    return e > s && this.loader ? this.loader(this.offset + s * 4, (e - s) * 4) : Promise.resolve();
  }

  subarray(start, end = this.length) {
    const s = Math.max(0, Math.min(start, this.length));
    const e = Math.max(s, Math.min(end, this.length));
    return e === s ? new Uint32Array(0) : readU32(this.read, this.offset + s * 4, e - s);
  }
}

// A UTF-8 section left on disk, addressed by byte offsets (`load` as for
// LazyU32).
export class LazyText {
  constructor(read, offset, length, load = null) {
    this.read = read;
    this.offset = offset;
    this.length = length;
    this.loader = load;
  }

  load(start, end) {
    return end > start && this.loader ? this.loader(this.offset + start, end - start) : Promise.resolve();
  }

  slice(start, end) {
    return end > start ? TEXT_DECODER.decode(this.read(this.offset + start, end - start)) : '';
  }
}

// Sections a search scans per keystroke: kept in memory by openIndexReader.
export const RESIDENT_RE = /^(order|rank$|formEntry$|audio)/;
export const RESIDENT_BYTES = 1 << 20;

// Thrown by BlockCache.readSync for a range that is not loaded yet; the
// caller loads it (BlockCache.load) and runs the synchronous step again
// (Dictionary.retry).
export class NeedBytes extends Error {
  constructor(offset, length) {
    super(`bytes ${offset}+${length} not loaded`);
    this.offset = offset;
    this.length = length;
  }
}

// Synchronous view of an asynchronous reader ({size, read(offset, length)
// -> Promise<Uint8Array>}): ranges up to spanBytes are kept as aligned
// blocks of blockBytes, larger ones as exact spans; least recently used
// data beyond maxBytes is dropped. readSync returns loaded bytes or throws
// NeedBytes; load(offset, length) fetches what is missing, one read per run
// of consecutive missing blocks.
export class BlockCache {
  constructor(reader, { blockBytes = 64 << 10, maxBytes = 32 << 20, spanBytes = 1 << 20 } = {}) {
    this.reader = reader;
    this.blockBytes = blockBytes;
    this.maxBytes = maxBytes;
    this.spanBytes = spanBytes;
    this.blocks = new Map();
    this.pending = new Map();
    this.bytes = 0;
    this.reads = 0;
    this.readBytes = 0;
  }

  touch(key, value) {
    this.blocks.delete(key);
    this.blocks.set(key, value);
  }

  insert(key, value) {
    const old = this.blocks.get(key);
    if (old) this.bytes -= old.length;
    this.touch(key, value);
    this.bytes += value.length;
    for (const [k, v] of this.blocks) {
      if (this.bytes <= this.maxBytes || k === key) break;
      this.blocks.delete(k);
      this.bytes -= v.length;
    }
  }

  readSync(offset, length) {
    if (length === 0) return new Uint8Array(0);
    if (length > this.spanBytes) {
      const key = `${offset}+${length}`;
      const span = this.blocks.get(key);
      if (!span) throw new NeedBytes(offset, length);
      this.touch(key, span);
      return span;
    }
    const B = this.blockBytes;
    const first = Math.floor(offset / B);
    const last = Math.floor((offset + length - 1) / B);
    if (first === last) {
      const block = this.blocks.get(first);
      if (!block) throw new NeedBytes(offset, length);
      this.touch(first, block);
      return block.subarray(offset - first * B, offset - first * B + length);
    }
    const out = new Uint8Array(length);
    for (let b = first; b <= last; b++) {
      const block = this.blocks.get(b);
      if (!block) throw new NeedBytes(offset, length);
      this.touch(b, block);
      const from = Math.max(offset, b * B);
      const to = Math.min(offset + length, b * B + block.length);
      out.set(block.subarray(from - b * B, to - b * B), from - offset);
    }
    return out;
  }

  async fetch(offset, length) {
    this.reads++;
    this.readBytes += length;
    const bytes = await this.reader.read(offset, length);
    if (bytes.length !== length) throw new Error(`short read: ${bytes.length} of ${length} bytes at ${offset}`);
    return bytes;
  }

  async load(offset, length) {
    if (length === 0) return;
    if (length > this.spanBytes) {
      const key = `${offset}+${length}`;
      if (!this.blocks.has(key)) this.insert(key, await this.fetch(offset, length));
      return;
    }
    const B = this.blockBytes;
    const first = Math.floor(offset / B);
    const last = Math.floor((offset + length - 1) / B);
    const waits = [];
    for (let b = first; b <= last;) {
      if (this.blocks.has(b)) {
        b++;
      } else if (this.pending.has(b)) {
        waits.push(this.pending.get(b));
        b++;
      } else {
        let end = b;
        while (end + 1 <= last && !this.blocks.has(end + 1) && !this.pending.has(end + 1)) end++;
        const b0 = b;
        const start = b * B;
        const stop = Math.min((end + 1) * B, this.reader.size);
        const run = this.fetch(start, stop - start).then((bytes) => {
          for (let k = b0; k <= end; k++) {
            // A copy per block, so that a dropped block frees its memory.
            this.insert(k, bytes.slice((k - b0) * B, Math.min((k - b0 + 1) * B, bytes.length)));
            this.pending.delete(k);
          }
        }, (err) => {
          for (let k = b0; k <= end; k++) this.pending.delete(k);
          throw err;
        });
        for (let k = b; k <= end; k++) this.pending.set(k, run);
        waits.push(run);
        b = end + 1;
      }
    }
    await Promise.all(waits);
  }
}

function headerOf(read) {
  const head = read(0, MAGIC.length + LENGTH_BYTES);
  for (let i = 0; i < MAGIC.length; i++) {
    if (head[i] !== MAGIC[i]) throw new Error('not a wiktionary-lookup index file');
  }
  const headerLen = new DataView(head.buffer, head.byteOffset, head.byteLength).getUint32(MAGIC.length, true);
  const headerStart = MAGIC.length + LENGTH_BYTES;
  const header = JSON.parse(TEXT_DECODER.decode(read(headerStart, headerLen)));
  if (header.version !== FORMAT_VERSION) throw new Error(`index version ${header.version}, expected ${FORMAT_VERSION}`);
  return { header, base: headerStart + headerLen + padTo(headerStart + headerLen, ALIGN) };
}

// Opens an index through a byte-range reader without reading it whole:
// the sections a search scans (order arrays, rank, formEntry, audio) and
// any section under 1 MiB are read into memory, every other u32 section
// becomes a LazyU32 and, when the header has textOffsets 'bytes', every
// text section a LazyText. Text sections of an index with code-unit offsets
// are decoded whole (the offsets need the string). -> {header, sections}
export function openIndexReader(read, { resident = RESIDENT_RE, residentBytes = RESIDENT_BYTES } = {}) {
  const { header, base } = headerOf(read);
  const sections = {};
  for (const d of header.sections) {
    const start = base + d.offset;
    if (d.type === 'utf8') {
      if (header.textOffsets !== 'bytes') sections[d.name] = TEXT_DECODER.decode(read(start, d.length));
      else if (d.length <= residentBytes) sections[d.name] = new ByteText(read(start, d.length));
      else sections[d.name] = new LazyText(read, start, d.length);
    } else if (d.type === 'u32') {
      sections[d.name] = resident.test(d.name) || d.length * 4 <= residentBytes
        ? readU32(read, start, d.length)
        : new LazyU32(read, start, d.length);
    } else {
      throw new Error(`unknown section type ${d.type}`);
    }
  }
  return { header, sections };
}

// Returns a Uint8Array holding the whole file. `meta` is merged into the JSON
// header (language, source, keys); `version` and `sections` are reserved.
export function serializeIndex(sections, meta = {}) {
  const encoder = new TextEncoder();
  const descriptors = [];
  const chunks = [];
  let offset = 0;
  for (const [name, value] of Object.entries(sections)) {
    let bytes;
    let type;
    if (typeof value === 'string') {
      bytes = encoder.encode(value);
      type = 'utf8';
    } else if (value instanceof Uint32Array) {
      bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      type = 'u32';
    } else {
      throw new TypeError(`unsupported section type for ${name}`);
    }
    offset += padTo(offset, ALIGN);
    // length is in bytes for utf8 and in elements for typed arrays.
    descriptors.push({ name, type, offset, length: type === 'utf8' ? bytes.length : value.length });
    chunks.push({ offset, bytes });
    offset += bytes.length;
  }
  const header = encoder.encode(JSON.stringify({ ...meta, version: FORMAT_VERSION, sections: descriptors }));
  const headerEnd = MAGIC.length + LENGTH_BYTES + header.length;
  const base = headerEnd + padTo(headerEnd, ALIGN);
  const out = new Uint8Array(base + offset);
  out.set(MAGIC, 0);
  new DataView(out.buffer).setUint32(MAGIC.length, header.length, true);
  out.set(header, MAGIC.length + LENGTH_BYTES);
  for (const c of chunks) out.set(c.bytes, base + c.offset);
  return out;
}

// Accepts a Uint8Array (a Node Buffer is one) or an ArrayBuffer; returns the
// sections only (see deserializeIndexWithHeader for the metadata).
export function deserializeIndex(input) {
  return deserializeIndexWithHeader(input).sections;
}

// -> {header, sections}; header is the parsed JSON header (version,
// sections descriptors and whatever metadata the builder wrote).
export function deserializeIndexWithHeader(input) {
  const buf = input instanceof ArrayBuffer ? new Uint8Array(input) : input;
  for (let i = 0; i < MAGIC.length; i++) {
    if (buf[i] !== MAGIC[i]) throw new Error('not a wiktionary-lookup index file');
  }
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const headerLen = view.getUint32(MAGIC.length, true);
  const headerStart = MAGIC.length + LENGTH_BYTES;
  const decoder = new TextDecoder();
  const header = JSON.parse(decoder.decode(buf.subarray(headerStart, headerStart + headerLen)));
  if (header.version !== FORMAT_VERSION) throw new Error(`index version ${header.version}, expected ${FORMAT_VERSION}`);
  const base = headerStart + headerLen + padTo(headerStart + headerLen, ALIGN);
  const sections = {};
  for (const d of header.sections) {
    const start = base + d.offset;
    if (d.type === 'utf8') {
      sections[d.name] = header.textOffsets === 'bytes'
        ? new ByteText(buf.subarray(start, start + d.length))
        : decoder.decode(buf.subarray(start, start + d.length));
    } else if (d.type === 'u32') {
      const absolute = buf.byteOffset + start;
      // A view needs 4-byte alignment relative to the ArrayBuffer; readFile
      // normally gives byteOffset 0 but pooled Buffers may not.
      sections[d.name] = absolute % ALIGN === 0
        ? new Uint32Array(buf.buffer, absolute, d.length)
        : new Uint32Array(buf.buffer.slice(absolute, absolute + d.length * 4));
    } else {
      throw new Error(`unknown section type ${d.type}`);
    }
  }
  return { header, sections };
}
