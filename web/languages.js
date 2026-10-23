// Language catalogue and index storage for the web app.
//
// The catalogue is manifest.json ({languages: [{code, name, entries, bytes,
// sha256, gzBytes, url}]}): a copy staged next to the page, replaced by the
// copy in the latest data release when that can be fetched. Entry URLs are
// relative to the release manifest URL, so the same manifest works from
// GitHub, from the Android proxy and from a test server.
//
// Downloaded indexes are kept decompressed in the Cache API; which languages
// are installed and which one is active is kept in localStorage. The index
// bundled with the page (index.idx), if any (bundle.json says), is always
// installed under BUNDLED_CODE.

import { gunzip } from './inflate.js';

export const BUNDLED_CODE = 'zh';
export const HANZI_CODE = 'hanzi';
const HANZI_KIND = 'pack';
const BUNDLED_NAME = 'Chinese';
const RELEASES = 'https://github.com/d33mobile/wiktionary-lookup-data/releases/';
const ANDROID_HOST = 'appassets.androidplatform.net';
// The Android app proxies this path to RELEASES: GitHub release downloads
// send no CORS headers, so the page cannot fetch them directly.
const ANDROID_PROXY = '/remote/';
const CACHE_NAME = 'wiktionary-indexes-v1';
const STATE_KEY = 'wiktionary-lookup.state';
const MANIFEST_KEY = 'wiktionary-lookup.manifest';
const MANIFEST_TIMEOUT_MS = 15000;

// Base URL of the data releases: ?data=URL overrides it (tests serve a copy).
export function releasesBase(location) {
  const override = new URLSearchParams(location.search).get('data');
  if (override) return new URL(override, location.href).href;
  if (location.hostname === ANDROID_HOST) return new URL(ANDROID_PROXY, location.href).href;
  return RELEASES;
}

export function manifestUrl(base) {
  return new URL('latest/download/manifest.json', base).href;
}

function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (err) {
    return fallback;
  }
}

function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (err) {
    // Storage full or disabled: the session still works, it is just not remembered.
  }
}

// "HTTP 502 (SocketTimeoutException: ...)": the Android release proxy puts
// what went wrong into the body of its error responses.
async function httpError(res) {
  let detail = '';
  try {
    detail = (await res.text()).trim().slice(0, 300);
  } catch (err) {
    detail = '';
  }
  return detail ? `HTTP ${res.status} (${detail})` : `HTTP ${res.status}`;
}

function hexDigest(buffer) {
  return Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, '0')).join('');
}

// The Android app's file storage for indexes (IndexStore), when present.
function nativeFiles() {
  const n = window.WiktionaryNative;
  return n && n.startIndexDownload ? n : null;
}

function fileName(code, kind) {
  return `${code}.${kind || 'idx'}`;
}

function localUrl(code, kind) {
  return new URL(`/local/${fileName(code, kind)}`, location.href).href;
}

// Downloads through the app (PageBridge.startIndexDownload); it reports
// back through window.onNativeDownload(id, state, done, total, error).
const nativeJobs = new Map();
let nativeJobId = 0;
window.onNativeDownload = (id, state, done, total, error) => {
  const job = nativeJobs.get(id);
  if (!job) return;
  if (state === 'progress') {
    job.onProgress(done, total, 'download');
  } else {
    nativeJobs.delete(id);
    if (state === 'done') job.resolve();
    else job.reject(error === 'cancelled' ? Object.assign(new Error('cancelled'), { name: 'AbortError' }) : new Error(error || 'download failed'));
  }
};

function nativeDownload(native, request, onProgress, signal) {
  const id = `d${++nativeJobId}`;
  return new Promise((resolve, reject) => {
    nativeJobs.set(id, { resolve, reject, onProgress });
    if (signal) signal.addEventListener('abort', () => native.cancelIndexDownload(id));
    native.startIndexDownload(JSON.stringify({ id, ...request }));
  });
}

function cacheKey(code, kind) {
  return new URL(`/__indexes/${encodeURIComponent(code)}.${kind || 'idx'}`, location.href).href;
}

function validManifest(m) {
  return m && Array.isArray(m.languages) && m.languages.every((l) => typeof l.code === 'string' && typeof l.name === 'string');
}

// gzip -> text (Dictionary.inflate, for getDetails): DecompressionStream
// where it exists (Chromium 80+), inflate.js otherwise.
export function inflateText(bytes) {
  if (typeof DecompressionStream === 'function') {
    return new Response(new Response(bytes).body.pipeThrough(new DecompressionStream('gzip'))).text();
  }
  return new TextDecoder().decode(gunzip(bytes));
}

// The catalogue: Wiktionary languages and Wikipedia title indexes (kind
// 'wikipedia', listed in `languages` or in a separate `wikipedia` array).
// A Wikipedia index is keyed 'wikipedia-<code>' (its file name too), so it
// does not collide with the Wiktionary language of the same code; `lang`
// keeps the language code (flags, voices).
export const WIKIPEDIA_PREFIX = 'wikipedia-';

function catalogueOf(manifest) {
  const all = manifest.languages.concat(Array.isArray(manifest.wikipedia) ? manifest.wikipedia : []);
  return all.map((l) => {
    if (l.kind !== 'wikipedia') return l;
    const lang = l.lang || (l.code.indexOf(WIKIPEDIA_PREFIX) === 0 ? l.code.slice(WIKIPEDIA_PREFIX.length) : l.code);
    return { ...l, code: WIKIPEDIA_PREFIX + lang, lang };
  });
}

export function isWikipedia(code) {
  return code.indexOf(WIKIPEDIA_PREFIX) === 0;
}

export class Languages {
  constructor({ base, bundledIndexUrl, bundledDetailsUrl, bundledManifestUrl }) {
    this.manifestUrl = manifestUrl(base);
    this.bundledIndexUrl = bundledIndexUrl;
    this.bundledDetailsUrl = bundledDetailsUrl;
    this.bundledManifestUrl = bundledManifestUrl;
    this.catalogue = [];
    this.catalogueSource = 'none';
    const state = readJson(STATE_KEY, {});
    // No saved state: the first start, when the app asks for a language.
    this.fresh = !state.installed;
    this.installed = state.installed || {};
    this.active = state.active || null;
    // Data files that are not languages: {hanzi: {bytes, sha256, storage}}.
    this.extras = state.extras || {};
    // The newest catalogue date (manifest "generated") seen so far: an older
    // catalogue never offers updates (a downgrade).
    this.newestSeen = state.newestSeen || '';
    this.catalogueGenerated = '';
    // The catalogue's character data entry (manifest "hanzi"), if any.
    this.hanziEntry = null;
    this.lostBundled = false;
  }

  // Whether the page comes with a built-in index (bundle.json). Without one,
  // a built-in Chinese of an earlier version is gone: it has to be
  // downloaded (lostBundled says so once).
  setBundled(hasIndex) {
    const zh = this.installed[BUNDLED_CODE];
    if (hasIndex) {
      this.installed[BUNDLED_CODE] = { code: BUNDLED_CODE, name: BUNDLED_NAME, ...zh, bundled: true };
    } else if (zh && zh.bundled) {
      delete this.installed[BUNDLED_CODE];
      this.lostBundled = true;
      this.save();
    }
    if (!this.installed[this.active]) this.active = this.fallback();
  }

  // The language to use when the active one is gone: the built-in one, else any.
  fallback() {
    if (this.installed[BUNDLED_CODE]) return BUNDLED_CODE;
    const codes = Object.keys(this.installed);
    return codes.length ? codes[0] : null;
  }

  isBundled(code) {
    return Boolean(this.installed[code] && this.installed[code].bundled);
  }

  save() {
    writeJson(STATE_KEY, { installed: this.installed, active: this.active, extras: this.extras, newestSeen: this.newestSeen });
  }

  setCatalogue(manifest, source) {
    this.catalogue = catalogueOf(manifest);
    this.catalogueSource = source;
    const generated = typeof manifest.generated === 'string' ? manifest.generated : '';
    this.catalogueGenerated = generated;
    let changed = false;
    if (generated && generated > this.newestSeen) {
      this.newestSeen = generated;
      changed = true;
    }
    // Installs from before 0.11 have no date: the catalogue whose file they match dates them.
    if (generated) {
      for (const lang of Object.values(this.installed)) {
        const cat = this.catalogue.find((l) => l.code === lang.code);
        if (!lang.generated && cat && cat.sha256 && cat.sha256 === lang.sha256) {
          lang.generated = generated;
          changed = true;
        }
      }
    }
    if (changed) this.save();
    const h = manifest.hanzi;
    this.hanziEntry = h && h.url ? { code: HANZI_CODE, name: 'Stroke order and character data', ...h } : null;
    const zh = this.catalogue.find((l) => l.code === BUNDLED_CODE);
    if (zh && this.installed[BUNDLED_CODE]) this.installed[BUNDLED_CODE].name = zh.name;
  }

  // The last fetched remote manifest, else the bundled one.
  async loadLocalCatalogue() {
    const remembered = readJson(MANIFEST_KEY, null);
    if (validManifest(remembered)) {
      this.setCatalogue(remembered, 'saved');
      return;
    }
    try {
      const res = await fetch(this.bundledManifestUrl);
      const m = res.ok ? await res.json() : null;
      if (validManifest(m)) this.setCatalogue(m, 'bundled');
    } catch (err) {
      // No bundled copy: the catalogue stays empty until the remote one arrives.
    }
  }

  async refreshCatalogue() {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), MANIFEST_TIMEOUT_MS);
    try {
      const res = await fetch(this.manifestUrl, { cache: 'no-cache', signal: ctl.signal });
      if (!res.ok) throw new Error(`manifest: ${await httpError(res)}`);
      const m = await res.json();
      if (!validManifest(m)) throw new Error('manifest: unexpected format');
      writeJson(MANIFEST_KEY, m);
      this.setCatalogue(m, 'remote');
    } finally {
      clearTimeout(timer);
    }
  }

  list() {
    return Object.values(this.installed).sort((a, b) => (b.bundled ? 1 : 0) - (a.bundled ? 1 : 0) || a.name.localeCompare(b.name));
  }

  activate(code) {
    if (!this.installed[code]) throw new Error(`${code} is not installed`);
    this.active = code;
    this.save();
  }

  // A {size, read(offset, length)} reader over a file the app stored, for
  // lib/lazy-index.js (/local/<file>?offset=&length=).
  fileReader(code, kind) {
    const native = nativeFiles();
    const size = native ? native.indexFileSize(fileName(code, kind)) : -1;
    if (size < 0) return Promise.reject(new Error(`the ${code} index is no longer stored, download it again`));
    const url = localUrl(code, kind);
    return Promise.resolve({
      size,
      async read(offset, length) {
        const res = await fetch(`${url}?offset=${offset}&length=${length}`);
        if (!res.ok) throw new Error(`${fileName(code, kind)}: HTTP ${res.status}`);
        return new Uint8Array(await res.arrayBuffer());
      },
    });
  }

  // Character data (Make Me a Hanzi, lib/hanzi-pack.js): downloaded like an
  // index, kept as hanzi.pack, read by range in the app.
  hanziUpdate() {
    const h = this.extras[HANZI_CODE];
    return Boolean(h && this.hanziEntry && h.sha256 && this.hanziEntry.sha256 && h.sha256 !== this.hanziEntry.sha256
      && this.catalogueIsNewer(h));
  }

  async installHanzi(onProgress, signal) {
    const entry = this.hanziEntry;
    if (!entry) throw new Error('no character data in the catalogue');
    const previous = this.extras[HANZI_CODE];
    const got = await this.fetchFile(entry, HANZI_KIND, onProgress, signal);
    if (previous && (previous.storage || 'cache') !== got.storage) await this.deleteStored(HANZI_CODE, HANZI_KIND, previous);
    this.extras[HANZI_CODE] = {
      bytes: entry.bytes || (got.bytes && got.bytes.byteLength), sha256: entry.sha256 || null, storage: got.storage,
      generated: this.catalogueGenerated || undefined,
    };
    this.save();
  }

  async removeHanzi() {
    const h = this.extras[HANZI_CODE];
    if (!h) return;
    await this.deleteStored(HANZI_CODE, HANZI_KIND, h);
    delete this.extras[HANZI_CODE];
    this.save();
  }

  // A byte-range reader over the installed character data, or null.
  async hanziReader() {
    const h = this.extras[HANZI_CODE];
    if (!h) return null;
    let reader = null;
    if (h.storage === 'file') {
      reader = await this.fileReader(HANZI_CODE, HANZI_KIND).catch(() => null);
      if (reader) return reader;
    }
    const buf = reader === null && h.storage === 'file' ? null : await this.readStored(HANZI_CODE, HANZI_KIND, h);
    if (!buf) {
      delete this.extras[HANZI_CODE];
      this.save();
      return null;
    }
    const bytes = new Uint8Array(buf);
    return { size: bytes.length, read: async (offset, length) => bytes.subarray(offset, offset + length) };
  }

  // Bytes of a downloaded file, or null when it is gone (storage cleared).
  // record.storage 'file': the Android app's storage, served at /local/;
  // otherwise the Cache API (browsers, and installs before 0.9).
  async readStored(code, kind, record) {
    if (record.storage === 'file') {
      const res = await fetch(localUrl(code, kind));
      return res.ok ? res.arrayBuffer() : null;
    }
    const res = await (await caches.open(CACHE_NAME)).match(cacheKey(code, kind));
    return res ? res.arrayBuffer() : null;
  }

  async deleteStored(code, kind, record) {
    if (record && record.storage === 'file') {
      const native = nativeFiles();
      if (native) native.deleteIndexFile(fileName(code, kind));
      return;
    }
    await (await caches.open(CACHE_NAME)).delete(cacheKey(code, kind));
  }

  // ArrayBuffer of an installed index. An index that went missing
  // (storage cleared by the user or the browser) is marked uninstalled.
  async read(code) {
    if (this.isBundled(code)) {
      const res = await fetch(this.bundledIndexUrl);
      if (!res.ok) throw new Error(`${this.bundledIndexUrl}: HTTP ${res.status}`);
      return res.arrayBuffer();
    }
    const bytes = await this.readStored(code, 'idx', this.installed[code]);
    if (!bytes) {
      delete this.installed[code];
      if (this.active === code) this.active = this.fallback();
      this.save();
      throw new Error(`the ${code} index is no longer stored, download it again`);
    }
    return bytes;
  }

  // The entry pages (.details sidecar) of an installed language as an
  // ArrayBuffer, or null when they are not installed.
  async readDetails(code) {
    const lang = this.installed[code];
    if (!lang) return null;
    if (lang.bundled) {
      if (!this.bundledDetailsUrl) return null;
      try {
        const res = await fetch(this.bundledDetailsUrl);
        return res.ok ? res.arrayBuffer() : null;
      } catch (err) {
        return null;
      }
    }
    if (!lang.details) return null;
    const bytes = await this.readStored(code, 'details', lang.details);
    if (!bytes) {
      delete lang.details;
      this.save();
    }
    return bytes;
  }

  hasDetails(code) {
    const lang = this.installed[code];
    if (!lang) return false;
    return lang.bundled ? Boolean(this.bundledDetailsUrl) : Boolean(lang.details);
  }

  // What a newer data release changed for an installed language: the
  // dictionary and/or the installed entry pages differ (by SHA-256) from
  // the catalogue. {index, details, bytes (download size)} or null.
  // Whether the catalogue is newer than what `record` was installed from:
  // never for an older catalogue (no silent downgrade).
  catalogueIsNewer(record) {
    const generated = this.catalogueGenerated;
    if (!generated) return true;
    if (record.generated) return generated > record.generated;
    return generated >= this.newestSeen;
  }

  updateFor(code) {
    const lang = this.installed[code];
    const cat = this.catalogue.find((l) => l.code === code);
    if (!lang || lang.bundled || !cat || !cat.url) return null;
    if (!this.catalogueIsNewer(lang)) return null;
    const index = Boolean(cat.sha256 && lang.sha256 && cat.sha256 !== lang.sha256);
    // A new index invalidates installed pages too (they are per build).
    const details = Boolean(lang.details && cat.details
      && (index || (cat.details.sha256 && lang.details.sha256 && cat.details.sha256 !== lang.details.sha256)));
    if (!index && !details) return null;
    const bytes = (index ? cat.gzBytes || cat.bytes || 0 : 0)
      + (details ? cat.details.gzBytes || cat.details.bytes || 0 : 0);
    return { index, details, bytes };
  }

  // Installs from before 0.4 kept no checksum: compute it once from the
  // stored file so updates can be detected. Returns the codes it filled in.
  async fillMissingChecksums() {
    const done = [];
    if (!crypto.subtle) return done;
    for (const code of Object.keys(this.installed)) {
      const lang = this.installed[code];
      if (lang.bundled || lang.sha256) continue;
      const bytes = await this.readStored(code, 'idx', lang);
      if (!bytes) continue;
      lang.sha256 = hexDigest(await crypto.subtle.digest('SHA-256', bytes));
      done.push(code);
    }
    if (done.length) this.save();
    return done;
  }

  // Downloads the entry pages of an installed language (manifest
  // entry.details); returns them as an ArrayBuffer, or null when the app
  // stored them as a file (read them with readDetails).
  async installDetails(entry, onProgress, signal) {
    const d = entry.details;
    const file = { code: entry.code, name: `${entry.name} entry pages`, url: d.url, bytes: d.bytes, sha256: d.sha256, gzBytes: d.gzBytes };
    const previous = this.installed[entry.code].details;
    const got = await this.fetchFile(file, 'details', onProgress, signal);
    if (previous && (previous.storage || 'cache') !== got.storage) await this.deleteStored(entry.code, 'details', previous);
    this.installed[entry.code].details = { bytes: d.bytes || (got.bytes && got.bytes.byteLength), sha256: d.sha256 || null, storage: got.storage };
    this.save();
    return got.bytes;
  }

  async removeDetails(code) {
    const lang = this.installed[code];
    if (!lang || lang.bundled || !lang.details) return;
    await this.deleteStored(code, 'details', lang.details);
    delete lang.details;
    this.save();
  }

  // Downloads, decompresses, verifies and stores one catalogue entry's
  // index (replacing an older one only once the new one is complete);
  // returns it as an ArrayBuffer, or null when the app stored it as a file.
  // onProgress(done, total, phase) reports 'download' bytes and, when the
  // WebView has no DecompressionStream, the 'unpack' step that follows.
  async install(entry, onProgress, signal) {
    const previous = this.installed[entry.code];
    const got = await this.fetchFile(entry, 'idx', onProgress, signal);
    if (previous && !previous.bundled && (previous.storage || 'cache') !== got.storage) await this.deleteStored(entry.code, 'idx', previous);
    this.installed[entry.code] = {
      code: entry.code, name: entry.name, entries: entry.entries, bytes: entry.bytes || (got.bytes && got.bytes.byteLength),
      sha256: entry.sha256 || null, storage: got.storage, kind: entry.kind || 'wiktionary', lang: entry.lang || entry.code,
      generated: this.catalogueGenerated || undefined,
    };
    // Entry pages belong to one build of the index: a new index drops them.
    if (previous && previous.details) {
      this.installed[entry.code].details = previous.details;
      await this.removeDetails(entry.code);
    }
    this.save();
    return got.bytes;
  }

  // file: {code, name, url, bytes, sha256, gzBytes} -> {storage, bytes}.
  // In the Android app (when the URL goes through its release proxy) the
  // app downloads into its storage; elsewhere the page does, into the Cache API.
  async fetchFile(entry, kind, onProgress, signal) {
    const url = new URL(entry.url, this.manifestUrl);
    const native = nativeFiles();
    if (native && url.host === location.host && url.pathname.indexOf(ANDROID_PROXY) === 0) {
      await nativeDownload(native, {
        name: fileName(entry.code, kind),
        path: decodeURIComponent(url.pathname.slice(ANDROID_PROXY.length)),
        bytes: entry.bytes || 0,
        sha256: entry.sha256 || '',
        gzip: url.pathname.endsWith('.gz'),
      }, onProgress, signal);
      return { storage: 'file', bytes: null };
    }
    const key = cacheKey(entry.code, kind);
    const res = await fetch(url, { signal });
    if (!res.ok || !res.body) throw new Error(`${entry.name}: ${await httpError(res)}`);
    const gzipped = url.pathname.endsWith('.gz');
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    const cache = await caches.open(CACHE_NAME);
    let bytes;
    if (!gzipped || typeof DecompressionStream === 'function') {
      bytes = await this.storeStreaming(res.body, gzipped, entry, onProgress, cache, key);
    } else {
      bytes = await this.storeUnpacked(res, entry, onProgress, cache, key);
    }
    try {
      if (entry.bytes && bytes.byteLength !== entry.bytes) {
        throw new Error(`${entry.name}: got ${bytes.byteLength} bytes, expected ${entry.bytes}`);
      }
      if (entry.sha256 && crypto.subtle) {
        if (hexDigest(await crypto.subtle.digest('SHA-256', bytes)) !== entry.sha256) throw new Error(`${entry.name}: checksum mismatch`);
      }
    } catch (err) {
      await cache.delete(key);
      throw err;
    }
    return { storage: 'cache', bytes };
  }

  // Chromium 80+: decompress while downloading and stream into the cache;
  // progress counts uncompressed bytes against entry.bytes.
  async storeStreaming(body, gzipped, entry, onProgress, cache, key) {
    let stream = gzipped ? body.pipeThrough(new DecompressionStream('gzip')) : body;
    let done = 0;
    stream = stream.pipeThrough(new TransformStream({
      transform(chunk, controller) {
        done += chunk.byteLength;
        onProgress(done, entry.bytes, 'download');
        controller.enqueue(chunk);
      },
    }));
    await cache.put(key, new Response(stream, { headers: { 'content-type': 'application/octet-stream' } }));
    return (await cache.match(key)).arrayBuffer();
  }

  // Older WebViews: download the compressed file into memory (progress
  // against entry.gzBytes), gunzip it with inflate.js, then store it.
  async storeUnpacked(res, entry, onProgress, cache, key) {
    const total = entry.gzBytes || Number(res.headers.get('content-length')) || 0;
    const reader = res.body.getReader();
    const chunks = [];
    let done = 0;
    for (;;) {
      const { value, done: finished } = await reader.read();
      if (finished) break;
      chunks.push(value);
      done += value.byteLength;
      onProgress(done, total, 'download');
    }
    const packed = new Uint8Array(done);
    let pos = 0;
    for (const c of chunks) {
      packed.set(c, pos);
      pos += c.byteLength;
    }
    chunks.length = 0;
    onProgress(0, 1, 'unpack');
    // Let the progress paint before the synchronous gunzip blocks the page.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const unpacked = gunzip(packed, entry.bytes);
    onProgress(1, 1, 'unpack');
    await cache.put(key, new Response(unpacked, { headers: { 'content-type': 'application/octet-stream' } }));
    return unpacked.buffer.byteLength === unpacked.byteLength
      ? unpacked.buffer
      : unpacked.buffer.slice(unpacked.byteOffset, unpacked.byteOffset + unpacked.byteLength);
  }

  async remove(code) {
    if (this.isBundled(code)) return;
    const lang = this.installed[code];
    await this.deleteStored(code, 'idx', lang);
    if (lang && lang.details) await this.deleteStored(code, 'details', lang.details);
    delete this.installed[code];
    if (this.active === code) this.active = this.fallback();
    this.save();
  }
}
