// Opening an index through an asynchronous byte-range reader, for a
// browser or WebView (fetch with Range, a native file read behind the
// WebView bridge) and for Node (lookup.js nodeFileReader). Browser-safe:
// no Node APIs.
//
// A reader is {size, read(offset, length) -> Promise<Uint8Array>}.
//
//   const d = await openIndexLazy(fetchRangeReader(url));
//   await d.searchAsync('new york');      // -> the same rows as search()
//
//   const d = await openIndexProgressive(reader, {
//     onProgress: ({ loaded, total, section }) => ...,
//     onSearchable: (partial) => ...,     // headword search works already
//   });                                   // the complete Dictionary
//
// openIndexLazy keeps only what a search scans or bisects in memory
// (LAZY_RESIDENT_RE, sections under 1 MiB); the rest is read on demand
// through a BlockCache (lib/index-format.js), so search goes through
// searchAsync. Pays off for an index with textOffsets 'bytes': the text of
// an index with code-unit offsets has to be decoded whole even then.
//
// openIndexProgressive reads every section, chunk by chunk with an await
// in between, so a page stays responsive (or it runs in a Worker), and
// calls onSearchable with a Dictionary that already searches headwords,
// forms and romanizations while the definition tables are still loading.
// Its result is an ordinary in-memory Dictionary (search() is synchronous).
import { Dictionary } from './engine.js';
import {
  BlockCache, ByteText, LazyText, LazyU32, FORMAT_VERSION, RESIDENT_BYTES,
} from './index-format.js';

// Kept in memory by openIndexLazy: what a search scans (order arrays, rank,
// formEntry, audio) and the word and gloss key tables it bisects (a few MiB
// to a few tens of MiB); postings and entry fields are read on demand.
export const LAZY_RESIDENT_RE = /^(order|rank$|formEntry$|audio|wordsBlob$|wordOffsets$|postStart$|glossBlob$|glossOffsets$|glossStart$)/;
const CACHE_BYTES = 64 << 20;

const MAGIC = 'PLKIDX1\n';
const ALIGN = 4;
const CHUNK_BYTES = 4 << 20;
// Definition tables: a search without them still finds headwords.
const DEFINITION_TABLES = ['wordsBlob', 'wordOffsets', 'postStart', 'postings', 'glossBlob', 'glossOffsets', 'glossStart', 'glossPostings'];
const DECODER = new TextDecoder();

async function readHeader(reader) {
  const head = await reader.read(0, MAGIC.length + 4);
  for (let i = 0; i < MAGIC.length; i++) {
    if (head[i] !== MAGIC.charCodeAt(i)) throw new Error('not a wiktionary-lookup index file');
  }
  const headerLen = new DataView(head.buffer, head.byteOffset, head.byteLength).getUint32(MAGIC.length, true);
  const headerStart = MAGIC.length + 4;
  const header = JSON.parse(DECODER.decode(await reader.read(headerStart, headerLen)));
  if (header.version !== FORMAT_VERSION) throw new Error(`index version ${header.version}, expected ${FORMAT_VERSION}`);
  const end = headerStart + headerLen;
  return { header, base: end + ((ALIGN - (end % ALIGN)) % ALIGN) };
}

// Reads one section whole, chunkBytes at a time.
async function readSection(reader, d, start, textOffsets, chunkBytes, progress) {
  const bytes = d.type === 'u32' ? d.length * 4 : d.length;
  if (d.type === 'u32') {
    const out = new Uint32Array(d.length);
    const view = new Uint8Array(out.buffer);
    for (let at = 0; at < bytes; at += chunkBytes) {
      const n = Math.min(chunkBytes, bytes - at);
      view.set(await reader.read(start + at, n), at);
      progress(d.name, n);
    }
    return out;
  }
  if (d.type !== 'utf8') throw new Error(`unknown section type ${d.type}`);
  if (textOffsets === 'bytes') {
    const out = new Uint8Array(bytes);
    for (let at = 0; at < bytes; at += chunkBytes) {
      const n = Math.min(chunkBytes, bytes - at);
      out.set(await reader.read(start + at, n), at);
      progress(d.name, n);
    }
    return new ByteText(out);
  }
  const decoder = new TextDecoder();
  const parts = [];
  for (let at = 0; at < bytes; at += chunkBytes) {
    const n = Math.min(chunkBytes, bytes - at);
    parts.push(decoder.decode(await reader.read(start + at, n), { stream: at + n < bytes }));
    progress(d.name, n);
  }
  return parts.join('');
}

// Section load order: what headword search needs first, the definition
// tables last.
function loadOrder(sections) {
  const late = (d) => (DEFINITION_TABLES.includes(d.name) ? 1 : 0);
  return [...sections].sort((a, b) => late(a) - late(b));
}

function withEmptyDefinitions(sections) {
  return {
    ...sections, wordsBlob: '', wordOffsets: new Uint32Array(1), postStart: new Uint32Array(1), postings: new Uint32Array(0),
  };
}

// options: onProgress({loaded, total, section}) after every chunk,
// onSearchable(dictionary) once headword search works (called with the
// final Dictionary when there is nothing left to load), chunkBytes (4 MiB),
// lazy (see openIndexLazy), resident, residentBytes, cache (BlockCache
// options). Resolves with the Dictionary.
export async function openIndexProgressive(reader, options = {}) {
  const {
    onProgress = null, onSearchable = null, chunkBytes = CHUNK_BYTES, lazy = false,
    resident = LAZY_RESIDENT_RE, residentBytes = RESIDENT_BYTES, cache: cacheOptions = {},
  } = options;
  const { header, base } = await readHeader(reader);
  const cache = lazy ? new BlockCache(reader, { maxBytes: CACHE_BYTES, ...cacheOptions }) : null;
  const read = cache ? (offset, length) => cache.readSync(offset, length) : null;
  const load = cache ? (offset, length) => cache.load(offset, length) : null;
  const sections = {};
  const toRead = [];
  for (const d of loadOrder(header.sections)) {
    const start = base + d.offset;
    const bytes = d.type === 'u32' ? d.length * 4 : d.length;
    const keep = !lazy || bytes <= residentBytes || resident.test(d.name)
      || (d.type === 'utf8' && header.textOffsets !== 'bytes');
    if (keep) toRead.push(d);
    else if (d.type === 'u32') sections[d.name] = new LazyU32(read, start, d.length, load);
    else sections[d.name] = new LazyText(read, start, d.length, load);
  }
  const total = toRead.reduce((n, d) => n + (d.type === 'u32' ? d.length * 4 : d.length), 0);
  let loaded = 0;
  const progress = (section, n) => {
    loaded += n;
    if (onProgress) onProgress({ loaded, total, section });
  };
  const finish = (d) => {
    if (cache) d.blockCache = cache;
    if (reader.close) d.close = () => reader.close();
    return d;
  };
  let announced = false;
  for (const d of toRead) {
    if (!announced && onSearchable && DEFINITION_TABLES.includes(d.name)) {
      announced = true;
      onSearchable(finish(new Dictionary(withEmptyDefinitions(sections), header)));
    }
    sections[d.name] = await readSection(reader, d, base + d.offset, header.textOffsets, chunkBytes, progress);
  }
  const dict = finish(new Dictionary(sections, header));
  if (!announced && onSearchable) onSearchable(dict);
  return dict;
}

// openIndexProgressive with lazy sections: resolves once the resident
// sections are read; search with searchAsync.
export function openIndexLazy(reader, options = {}) {
  return openIndexProgressive(reader, { ...options, lazy: true });
}

// A reader over HTTP Range requests. The server must answer a Range request
// with 206 (static servers, GitHub release assets through a proxy that
// keeps the header). `size` comes from a HEAD request when not given.
export async function fetchRangeReader(url, { size = null, fetchFn = fetch } = {}) {
  let total = size;
  if (total === null) {
    const head = await fetchFn(url, { method: 'HEAD' });
    if (!head.ok) throw new Error(`${url}: HTTP ${head.status}`);
    total = Number(head.headers.get('content-length'));
    if (!Number.isFinite(total) || total <= 0) throw new Error(`${url}: no Content-Length`);
  }
  return {
    size: total,
    async read(offset, length) {
      const response = await fetchFn(url, { headers: { Range: `bytes=${offset}-${offset + length - 1}` } });
      if (response.status !== 206) throw new Error(`${url}: HTTP ${response.status} to a Range request (206 expected)`);
      return new Uint8Array(await response.arrayBuffer());
    },
  };
}
