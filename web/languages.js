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
// bundled with the page (index.idx) is always installed under BUNDLED_CODE.

import { gunzip } from './inflate.js';

export const BUNDLED_CODE = 'zh';
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
    this.active = state.active || BUNDLED_CODE;
    this.installed[BUNDLED_CODE] = { code: BUNDLED_CODE, name: BUNDLED_NAME, ...this.installed[BUNDLED_CODE], bundled: true };
    if (!this.installed[this.active]) this.active = BUNDLED_CODE;
  }

  isBundled(code) {
    return Boolean(this.installed[code] && this.installed[code].bundled);
  }

  save() {
    writeJson(STATE_KEY, { installed: this.installed, active: this.active });
  }

  setCatalogue(manifest, source) {
    this.catalogue = manifest.languages;
    this.catalogueSource = source;
    const zh = this.catalogue.find((l) => l.code === BUNDLED_CODE);
    if (zh) this.installed[BUNDLED_CODE].name = zh.name;
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

  // ArrayBuffer of an installed index. A cached index that went missing
  // (storage cleared by the user or the browser) is marked uninstalled.
  async read(code) {
    if (this.isBundled(code)) {
      const res = await fetch(this.bundledIndexUrl);
      if (!res.ok) throw new Error(`${this.bundledIndexUrl}: HTTP ${res.status}`);
      return res.arrayBuffer();
    }
    const cache = await caches.open(CACHE_NAME);
    const res = await cache.match(cacheKey(code));
    if (!res) {
      delete this.installed[code];
      if (this.active === code) this.active = BUNDLED_CODE;
      this.save();
      throw new Error(`the ${code} index is no longer stored, download it again`);
    }
    return res.arrayBuffer();
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
    const res = await (await caches.open(CACHE_NAME)).match(cacheKey(code, 'details'));
    if (!res) {
      delete lang.details;
      this.save();
      return null;
    }
    return res.arrayBuffer();
  }

  hasDetails(code) {
    const lang = this.installed[code];
    if (!lang) return false;
    return lang.bundled ? Boolean(this.bundledDetailsUrl) : Boolean(lang.details);
  }

  // Downloads the entry pages of an installed language (manifest
  // entry.details); returns them as an ArrayBuffer.
  async installDetails(entry, onProgress, signal) {
    const d = entry.details;
    const file = { code: entry.code, name: `${entry.name} entry pages`, url: d.url, bytes: d.bytes, sha256: d.sha256, gzBytes: d.gzBytes };
    const bytes = await this.fetchFile(file, cacheKey(entry.code, 'details'), onProgress, signal);
    this.installed[entry.code].details = { bytes: bytes.byteLength, sha256: d.sha256 || null };
    this.save();
    return bytes;
  }

  async removeDetails(code) {
    const lang = this.installed[code];
    if (!lang || lang.bundled) return;
    await (await caches.open(CACHE_NAME)).delete(cacheKey(code, 'details'));
    delete lang.details;
    this.save();
  }

  // Downloads, decompresses (for .gz URLs), verifies and stores one
  // catalogue entry's index; returns it as an ArrayBuffer.
  // onProgress(done, total, phase) reports 'download' bytes and, when the
  // WebView has no DecompressionStream, the 'unpack' step that follows.
  async install(entry, onProgress, signal) {
    const bytes = await this.fetchFile(entry, cacheKey(entry.code), onProgress, signal);
    const previous = this.installed[entry.code];
    this.installed[entry.code] = {
      code: entry.code, name: entry.name, entries: entry.entries, bytes: bytes.byteLength, sha256: entry.sha256 || null,
    };
    // Entry pages belong to one build of the index: a new index drops them.
    if (previous && previous.details) await this.removeDetails(entry.code);
    this.save();
    return bytes;
  }

  // file: {code, name, url, bytes, sha256, gzBytes} -> stored under key.
  async fetchFile(entry, key, onProgress, signal) {
    const url = new URL(entry.url, this.manifestUrl);
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
        const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
        const hex = Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
        if (hex !== entry.sha256) throw new Error(`${entry.name}: checksum mismatch`);
      }
    } catch (err) {
      await cache.delete(key);
      throw err;
    }
    return bytes;
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
    const cache = await caches.open(CACHE_NAME);
    await cache.delete(cacheKey(code));
    await cache.delete(cacheKey(code, 'details'));
    delete this.installed[code];
    if (this.active === code) this.active = BUNDLED_CODE;
    this.save();
  }
}
