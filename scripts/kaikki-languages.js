#!/usr/bin/env node
// Languages of English Wiktionary as published by kaikki.org (wiktextract),
// one JSONL file per language.
//
//   node scripts/kaikki-languages.js list [OUT]        fetch the list -> data/languages.json
//   node scripts/kaikki-languages.js download DIR CODE...  download <DIR>/<code>.jsonl
//
// `list` reads https://kaikki.org/dictionary/alphabetical.html (name and
// sense count of every language), each language page (the JSONL link, whose
// file name drops spaces and punctuation: "K'iche'" -> Kiche), a HEAD of the
// JSONL (size, Last-Modified) and its first line (lang_code). The result is
// {extracted, dumpDate, languages: [{code, name, senses, bytes, url}]},
// sorted by name; extracted/dumpDate come from the "extracted on ... from
// the enwiktionary dump dated ..." line of the list page.
import { writeFile, rename, mkdir, stat } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const BASE = 'https://kaikki.org/dictionary/';
const HERE = dirname(fileURLToPath(import.meta.url));
export const LANGUAGES_JSON = join(HERE, '..', 'data', 'languages.json');
const CONCURRENCY = 4;
const RETRIES = 4;
const FIRST_LINE_CHUNK = 1 << 16;
const FIRST_LINE_MAX = 1 << 24;

async function fetchRetry(url, init = {}) {
  let lastErr;
  for (let attempt = 0; attempt < RETRIES; attempt++) {
    try {
      const res = await fetch(url, init);
      if (res.ok || res.status === 206) return res;
      lastErr = new Error(`${url}: HTTP ${res.status}`);
      if (res.status === 404) break;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
  }
  throw lastErr;
}

const text = async (url) => (await fetchRetry(url)).text();
const unescapeHtml = (s) => s.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#([0-9]+);/g, (_, d) => String.fromCodePoint(Number(d))).replace(/&quot;/g, '"').replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>').replace(/&amp;/g, '&');

// [{name, page, senses}] from the alphabetical list page.
export function parseLanguageList(html) {
  const out = [];
  for (const m of html.matchAll(/<li><a href="([^"]+)\/index\.html">([^<]+) \((\d+) senses\)<\/a><\/li>/g)) {
    const name = unescapeHtml(m[2]);
    if (name === 'All languages combined') continue;
    out.push({ name, page: new URL(`${m[1]}/index.html`, BASE).href, senses: Number(m[3]) });
  }
  return out;
}

export function parseDates(html) {
  const m = html.match(/extracted on (\d{4}-\d{2}-\d{2}) from the enwiktionary dump dated (\d{4}-\d{2}-\d{2})/);
  return m ? { extracted: m[1], dumpDate: m[2] } : { extracted: null, dumpDate: null };
}

// lang_code of the first record, read with growing range requests.
async function firstLangCode(url) {
  for (let size = FIRST_LINE_CHUNK; size <= FIRST_LINE_MAX; size *= 4) {
    const res = await fetchRetry(url, { headers: { Range: `bytes=0-${size - 1}`, 'Accept-Encoding': 'identity' } });
    const body = await res.text();
    const nl = body.indexOf('\n');
    if (nl >= 0 || res.status === 200) return JSON.parse(nl >= 0 ? body.slice(0, nl) : body).lang_code ?? null;
  }
  throw new Error(`${url}: first line longer than ${FIRST_LINE_MAX} bytes`);
}

async function describe(lang) {
  const page = await text(lang.page);
  const href = page.match(/href="([^"]+\.jsonl)"/);
  if (!href) throw new Error(`${lang.page}: no JSONL link`);
  const url = new URL(href[1], lang.page).href;
  // Without identity the server reports the gzip-compressed length; fetch
  // still downloads compressed and inflates transparently (download()).
  const head = await fetchRetry(url, { method: 'HEAD', headers: { 'Accept-Encoding': 'identity' } });
  const bytes = Number(head.headers.get('content-length'));
  const code = await firstLangCode(url);
  return { code, name: lang.name, senses: lang.senses, bytes, url };
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: limit }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}

export async function listLanguages(log = console.error) {
  const html = await text(`${BASE}alphabetical.html`);
  const langs = parseLanguageList(html);
  log(`${langs.length} languages listed`);
  let done = 0;
  const described = await mapLimit(langs, CONCURRENCY, async (lang) => {
    try {
      return await describe(lang);
    } catch (err) {
      log(`  ${lang.name}: ${err.message}`);
      return { code: null, name: lang.name, senses: lang.senses, bytes: null, url: null, error: err.message };
    } finally {
      if (++done % 25 === 0) log(`  ${done}/${langs.length}`);
    }
  });
  // Codes must be unique file names; a missing or repeated one gets a suffix.
  const seen = new Map();
  for (const l of described) {
    let code = l.code ?? l.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    if (seen.has(code)) code = `${code}-${l.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
    seen.set(code, l.name);
    l.code = code;
  }
  return { ...parseDates(html), languages: described.sort((a, b) => a.name.localeCompare(b.name)) };
}

// Downloads url to path through a temporary file, skipping a complete file.
export async function download(url, path, expectedBytes) {
  try {
    if ((await stat(path)).size === expectedBytes) return false;
  } catch { /* not there yet */ }
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.part`;
  const res = await fetchRetry(url);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
  const size = (await stat(tmp)).size;
  if (expectedBytes && size !== expectedBytes) throw new Error(`${url}: got ${size} bytes, expected ${expectedBytes}`);
  await rename(tmp, path);
  return true;
}

async function main([cmd, ...args]) {
  if (cmd === 'list') {
    const out = args[0] ?? LANGUAGES_JSON;
    const list = await listLanguages();
    await writeFile(out, `${JSON.stringify(list, null, 1)}\n`);
    const total = list.languages.reduce((s, l) => s + (l.bytes ?? 0), 0);
    console.log(`${list.languages.length} languages, ${(total / 1e9).toFixed(1)} GB of JSONL, dump ${list.dumpDate} -> ${out}`);
  } else if (cmd === 'download' && args.length >= 2) {
    const [dir, ...codes] = args;
    const { languages } = JSON.parse(await (await import('node:fs/promises')).readFile(LANGUAGES_JSON, 'utf8'));
    for (const code of codes) {
      const lang = languages.find((l) => l.code === code);
      if (!lang?.url) throw new Error(`unknown language code ${code}`);
      const fresh = await download(lang.url, join(dir, `${code}.jsonl`), lang.bytes);
      console.log(`${code}: ${fresh ? 'downloaded' : 'already complete'} (${lang.bytes} bytes)`);
    }
  } else {
    console.error('usage: kaikki-languages.js list [OUT] | download DIR CODE...');
    process.exit(2);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((err) => { console.error(err); process.exit(1); });
}
