// Source plugin: article titles of a Wikipedia, from the TSV that
// scripts/wikipedia-prepare.js joins out of the SQL dumps (page, redirect,
// page_props, clickstream). Wikipedia text, titles and short descriptions
// included, is CC BY-SA 4.0; the clickstream is CC0.
//
//   node build-index.js sources/wikipedia-titles.js /mnt/biglinks/wikipedia/enwiki-titles.tsv OUT
//
// Mapping to the entry shape:
// - simp: the article title ("New York City").
// - trad, pinyin: ''.
// - definition: the short description ("Most populous city in the United
//   States"), or ''.
// - forms: the titles of the redirects to the article ("NYC", "New York,
//   New York"), without those whose headword key equals the title's or an
//   earlier form's (case and diacritics variants find the title anyway).
// - freq: log2 of the article's views in the clickstream month, 1/16 steps;
//   none for an article without views.
//
// The file name tells the wiki: "<lang>wiki-titles.tsv" (enwiki, plwiki);
// info.entryUrl is the article URL with "{title}" in place of the title;
// the index has byte offsets (info.textOffsets) so it can be opened lazily.
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { basename } from 'node:path';
import { foldText } from '../lib/normalize.js';

export const KEYS = Object.freeze({ headword: 'fold', romanization: 'fold' });
export const REDIRECT_SEPARATOR = '\x1f';
const FREQ_STEPS = 16;
const WIKI_RE = /^([a-z][a-z-]*)wiki-/;
// The languages this has been run on; others get their code as the name.
const LANGUAGE_NAMES = { en: 'English', pl: 'Polish', de: 'German', fr: 'French', zh: 'Chinese' };
const SCRIPTS = { zh: 'Hani' };

// One TSV line -> entry, or null for a malformed line.
export function entryOf(line) {
  const [title, views, description, redirects] = line.split('\t');
  if (!title || redirects === undefined) return null;
  const seen = new Set([foldText(title)]);
  const forms = [];
  for (const r of redirects === '' ? [] : redirects.split(REDIRECT_SEPARATOR)) {
    const key = foldText(r);
    if (seen.has(key)) continue;
    seen.add(key);
    forms.push(r);
  }
  const v = Number(views);
  return {
    simp: title,
    trad: '',
    pinyin: '',
    definition: description,
    forms,
    freq: v > 0 ? Math.round(Math.log2(v) * FREQ_STEPS) : undefined,
  };
}

export function articleUrl(code, title) {
  return `https://${code}.wikipedia.org/wiki/${encodeURIComponent(title.replaceAll(' ', '_'))}`;
}

export async function* entries(path, info = {}) {
  const code = (basename(path).match(WIKI_RE) || [null, 'en'])[1];
  info.language = { code, name: LANGUAGE_NAMES[code] || code, script: SCRIPTS[code] || 'Latn', hasRomanization: false };
  info.keys = KEYS;
  info.source = {
    name: `${code}.wikipedia.org article titles, redirects and short descriptions`,
    url: `https://dumps.wikimedia.org/${code}wiki/latest/`,
    license: 'CC BY-SA 4.0',
  };
  info.entryUrl = `https://${code}.wikipedia.org/wiki/{title}`;
  // Fields readable by byte range (lib/index-format.js openIndexReader).
  info.textOffsets = 'bytes';
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  for await (const line of lines) {
    const e = entryOf(line);
    if (e) yield e;
  }
}
