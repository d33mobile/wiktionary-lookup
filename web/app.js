// Browser front end of the lookup engine. Loads the active language's index
// (the bundled index.idx, or one downloaded through the language picker),
// searches on every keystroke with one Session so each character narrows the
// previous range, shows the top results grouped by the key they matched on
// and a detail view on tap. Runs unbundled; ../lib/engine.js and its imports
// are plain ES modules without Node APIs.
//
// Query parameters: ?index=URL replaces the bundled index, ?data=URL the base
// of the data releases (see languages.js).
import { openIndex } from '../lib/engine.js';
import { openIndexLazy, openIndexProgressive } from '../lib/lazy-index.js';
import { deserializeIndexWithHeader } from '../lib/index-format.js';
import { BUNDLED_CODE, inflateText, isWikipedia, Languages, releasesBase } from './languages.js';

import {
  getPrefetchMode, openSpeechSettings, pronounce, setPrefetchMode,
} from './pronounce.js';
import { detailBody, isCjkChar, pronunciationLines, tapText, wiktionaryUrl } from './detail.js';
import { loadRecognizer, Pad } from './handwriting.js';
import {
  clearHistory, dayLabel, exportFavourites, history as historyItems, historyPaused, importFavourites, isFavourite,
  itemKey, recordView, removeFavourite, removeHistory, setHistoryPaused, sortedFavourites, toggleFavourite,
} from './library.js';

const LIMIT = 50;
const PICKER_ROWS = 200;
// Opening an index takes about twice its size in memory (the buffer plus the
// decoded text); larger downloads ask for a second tap with a warning.
const LARGE_INDEX_BYTES = 64 * 1048576;
const MEMORY_FACTOR = 2;
const GIB = 1073741824;
const params = new URLSearchParams(location.search);
const input = document.getElementById('q');
const statusLine = document.getElementById('status');
const results = document.getElementById('results');
const detail = document.getElementById('detail');
const picker = document.getElementById('picker');
const langFilter = document.getElementById('lang-filter');
const langList = document.getElementById('lang-list');
const pickerStatus = document.getElementById('picker-status');

const languages = new Languages({
  base: releasesBase(location),
  bundledIndexUrl: params.get('index') || 'index.idx',
  // The built-in language's entry pages: next to ?index=, or index.details
  // when bundle.json (written by stage-web.js) says it is there.
  bundledDetailsUrl: params.get('index') ? params.get('index').replace(/\.idx$/, '') + '.details' : null,
  bundledManifestUrl: 'manifest.json',
});

let dict = null;
let session = null;
// Exact-headword lookups for taps, separate from the search box's session.
let lookupSession = null;
let loadInfo = '';
let current = [];
// code -> {done, total, controller} for downloads in progress
const downloads = new Map();
// codes whose size warning is showing
const warned = new Set();

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// Element.replaceChildren is Chromium 86; the app also runs on older WebViews.
function replaceChildren(parent, ...nodes) {
  while (parent.firstChild) parent.removeChild(parent.firstChild);
  parent.append(...nodes);
}

function installedName(code) {
  const l = languages.installed[code];
  return l ? l.name : code;
}

// Flags (regional indicator pairs from flags.json) or, for languages without
// one clear country, a sign of their script.
let flags = {};
const SCRIPT_SIGNS = {
  Latn: 'Aa', Cyrl: 'Аа', Grek: 'Αα', Arab: 'ع', Hebr: 'א', Geor: 'ა', Armn: 'Ա', Deva: 'अ', Beng: 'অ',
  Gujr: 'અ', Knda: 'ಅ', Mlym: 'അ', Orya: 'ଅ', Tibt: 'ཀ', Mymr: 'က', Khmr: 'ក', Laoo: 'ກ', Thai: 'ก',
  Ethi: 'አ', Syrc: 'ܐ', Thaa: 'ދ', Hani: '文', Hang: '한', Kore: '한', Kana: 'あ', Jpan: 'あ', Mong: 'ᠠ',
};

function scriptOf(code) {
  const c = languages.catalogue.find((l) => l.code === code);
  return (c && c.script) || (languages.installed[code] && languages.installed[code].script) || '';
}

function languageMark(code) {
  if (isWikipedia(code)) code = code.slice('wikipedia-'.length);
  const cc = flags[code];
  if (cc && /^[A-Z]{2}$/.test(cc)) {
    return { text: String.fromCodePoint(0x1F1E6 + cc.charCodeAt(0) - 65, 0x1F1E6 + cc.charCodeAt(1) - 65), flag: true };
  }
  return { text: SCRIPT_SIGNS[scriptOf(code)] || code, flag: false };
}

function markElement(code) {
  const mark = languageMark(code);
  const span = el('span', mark.flag ? 'lang-mark flag' : 'lang-mark sign', mark.text);
  span.setAttribute('aria-hidden', 'true');
  return span;
}

// "12 KiB" below 1 MiB, "3.4 MiB" above.
function formatSize(bytes) {
  if (bytes < 1048576) return `${Math.max(1, Math.round(bytes / 1024))} KiB`;
  return `${(bytes / 1048576).toFixed(1)} MiB`;
}

function headword(entry) {
  const frag = document.createDocumentFragment();
  frag.append(el('span', 'head', entry.simp));
  if (entry.trad && entry.trad !== entry.simp) frag.append(el('span', 'trad', entry.trad));
  if (entry.pinyin) frag.append(el('span', 'pinyin', entry.pinyin));
  return frag;
}

// Group heading for an entry's matchedOn key.
function groupLabel(matchedOn) {
  switch (matchedOn) {
    case 'simp':
    case 'trad':
    case 'headword':
      return 'Headword';
    case 'pinyinToned':
    case 'pinyinBare':
    case 'pinyin':
      return ((dict && dict.language && dict.language.code) || languages.active) === 'zh' ? 'Pinyin' : 'Romanization';
    case 'definition':
      return 'English';
    default:
      return matchedOn ? matchedOn.replace(/^./, (c) => c.toUpperCase()) : 'Other';
  }
}

// Groups keep the engine's order inside them and appear in the order of
// their best entry.
function render(rows) {
  const groups = new Map();
  for (const entry of rows) {
    const label = groupLabel(entry.matchedOn);
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(entry);
  }
  current = [];
  const items = [];
  for (const [label, entries] of groups) {
    const heading = el('li', 'group', label);
    heading.setAttribute('role', 'presentation');
    items.push(heading);
    for (const entry of entries) {
      const li = el('li');
      li.tabIndex = 0;
      li.dataset.index = String(current.length);
      current.push(entry);
      const line = el('div', 'line');
      const words = el('div', 'words');
      words.append(headword(entry));
      line.append(words);
      const speak = rowSpeakButton(entry);
      if (speak) line.append(speak);
      line.append(starButton(entry));
      li.append(line, el('div', 'def', entry.definition.split('/').join('; ')));
      items.push(li);
    }
  }
  replaceChildren(results, ...items);
}

const SVG_NS = 'http://www.w3.org/2000/svg';
// Speaker: a real Wiktionary recording. Speech bubble with a waveform:
// text-to-speech.
const SPEAKER_PATH = 'M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 7.97v8.05A4.5 4.5 0 0 0 16.5 12zM14 3.23v2.06a7 7 0 0 1 0 13.42v2.06a9 9 0 0 0 0-17.54z';
const BUBBLE_PATH = 'M4 3.5h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H10l-5 4v-4H4a2 2 0 0 1-2-2v-10a2 2 0 0 1 2-2z';
const WAVE_PATH = 'M7 10.5v0M9.5 8.5v4M12 6.5v8M14.5 8.5v4M17 10.5v0';

function icon(kind) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const parts = kind === 'audio' ? [[SPEAKER_PATH, 'fill']] : [[BUBBLE_PATH, 'outline'], [WAVE_PATH, 'wave']];
  for (const [d, cls] of parts) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    path.setAttribute('class', cls);
    svg.appendChild(path);
  }
  return svg;
}

function hasAudio(entry) {
  return Array.isArray(entry.audio) && entry.audio.length > 0;
}

const STAR_PATH = 'M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z';

function starButton(entry, withLabel) {
  const on = isFavourite(entry, languages.active);
  const b = el('button', on ? 'star on' : 'star');
  b.type = 'button';
  b.title = on ? 'Remove from favourites' : 'Add to favourites';
  b.setAttribute('aria-label', b.title);
  b.setAttribute('aria-pressed', String(on));
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', STAR_PATH);
  svg.appendChild(path);
  b.append(svg);
  if (withLabel) b.append(el('span', 'speak-label', on ? 'Favourite' : 'Add to favourites'));
  return b;
}

function toggleStar(entry, button, withLabel) {
  toggleFavourite(entry, languages.active);
  const fresh = starButton(entry, withLabel);
  if (button.id) fresh.id = button.id;
  button.replaceWith(fresh);
}

// kind 'audio' plays the entry's recording, 'tts' speaks the headword.
function speakButton(kind, withLabel, entry) {
  const label = kind === 'audio' ? 'Wiktionary audio' : 'Text-to-speech';
  const b = el('button', `speak speak-${kind}`);
  b.type = 'button';
  b.dataset.kind = kind;
  b.title = label;
  b.setAttribute('aria-label', label);
  b.append(icon(kind));
  if (withLabel) b.append(el('span', 'speak-label', label));
  if (kind === 'audio' && entry) b.dataset.audio = entry.audio[0];
  return b;
}

// Recordings on screen are downloaded in the background (Android app, per
// the "Prefetch audio" setting) and marked once they are on the device.
const PREFETCH_MAX = 10;
const PREFETCH_DELAY_MS = 300;
let prefetchTimer = 0;

function prefetchAllowed() {
  const native = window.WiktionaryNative;
  if (!native || !native.prefetchAudio) return false;
  const mode = getPrefetchMode();
  if (mode === 'off' || networkProblem()) return false;
  return mode === 'always' || !native.networkMetered();
}

function markCached(name) {
  const buttons = document.querySelectorAll('button.speak-audio');
  for (let i = 0; i < buttons.length; i++) {
    if (buttons[i].dataset.audio === name) {
      buttons[i].classList.add('cached');
      buttons[i].title = 'Wiktionary audio (saved on this device)';
    }
  }
}
window.onAudioCached = markCached;

function prefetchFor(entries) {
  clearTimeout(prefetchTimer);
  const native = window.WiktionaryNative;
  if (!native || !native.cachedAudio) return;
  const names = [];
  for (const e of entries) {
    if (hasAudio(e) && names.indexOf(e.audio[0]) < 0) names.push(e.audio[0]);
    if (names.length >= PREFETCH_MAX) break;
  }
  if (!names.length) return;
  JSON.parse(native.cachedAudio(JSON.stringify(names))).forEach(markCached);
  // Wait for typing to pause; the next query cancels files not yet started.
  prefetchTimer = setTimeout(() => {
    if (prefetchAllowed()) native.prefetchAudio(JSON.stringify(names));
  }, PREFETCH_DELAY_MS);
}

// In the result list: the speaker only for entries with a recording.
function rowSpeakButton(entry) {
  if (isWikipedia(languages.active)) return null;
  return hasAudio(entry) ? speakButton('audio', false, entry) : null;
}

function languageCode() {
  return (dict && dict.language && dict.language.code) || languages.active;
}

function showSpeechHint(text) {
  const hint = document.getElementById('speech-hint');
  document.getElementById('speech-hint-text').textContent = text;
  document.getElementById('speech-settings').hidden = !(window.WiktionaryNative && window.WiktionaryNative.openTtsSettings);
  hint.hidden = !text;
}

async function sayEntry(entry, options) {
  showSpeechHint('');
  const r = await pronounce(entry, languageCode(), options);
  const name = installedName(languages.active);
  document.body.dataset.spoke = `${r.kind}:${r.status}`;
  if (r.status === 'ok') {
    statusLine.textContent = r.kind === 'audio' ? `Wiktionary audio: ${r.detail}` : `Text-to-speech (${name})`;
  } else if (r.status === 'no-voice') {
    showSpeechHint(`No text-to-speech voice for ${name}. Install one in the system speech settings.`);
  } else if (r.status === 'no-engine') {
    showSpeechHint('No text-to-speech engine on this device. Install one (for example Speech Services by Google).');
  } else if (r.status === 'unsupported') {
    showSpeechHint('This browser has no speech output.');
  } else {
    showSpeechHint('Text-to-speech failed.');
  }
}

// Detail views form a stack, one history entry each: Back (the button, the
// browser's or Android's) pops one, and the search box drops them all.
const stack = [];
const WORD_MAX_CHARS = 8;
const MAX_OTHERS = 6;

// Details of an entry (or null): the index's lazily inflated blocks.
async function getDetails(entry) {
  try {
    if (dict && typeof dict.getDetails === 'function' && entry.id !== undefined) return await dict.getDetails(entry.id);
  } catch (err) {
    console.warn('details:', err.message);
  }
  return null;
}

function romanLabel() {
  return ((dict && dict.language && dict.language.code) || languages.active) === 'zh' ? 'Pinyin' : 'Romanization';
}

function renderPronunciation(entry, details) {
  replaceChildren(document.getElementById('detail-pinyin'), ...pronunciationLines(entry, details, romanLabel()).map(([label, text]) => {
    const line = el('div', 'pron-line');
    if (label) line.appendChild(el('span', 'pron-label', `${label}: `));
    line.appendChild(el('span', 'pron-text', text));
    return line;
  }));
}

// Shows the entry at once from its definition, then the full page when the
// details block is inflated (if this view is still the one on top).
function renderDetail(view) {
  const { entry, extras } = view;
  const details = null;
  replaceChildren(document.getElementById('detail-head'), tapText('span', 'head', entry.simp));
  const variants = document.getElementById('detail-variants');
  replaceChildren(variants);
  if (entry.trad && entry.trad !== entry.simp) {
    const isZh = Array.from(entry.simp).some(isCjkChar);
    variants.append(el('span', 'variant-label', isZh ? 'Traditional ' : 'Also '), tapText('span', 'trad', entry.trad));
  }
  variants.hidden = !variants.firstChild;
  renderPronunciation(entry, details);
  replaceChildren(document.getElementById('detail-speak-row'),
    ...(hasAudio(entry) ? [Object.assign(speakButton('audio', true, entry), { id: 'detail-speak' })] : []),
    Object.assign(speakButton('tts', true), { id: 'detail-tts' }),
    Object.assign(starButton(entry, true), { id: 'detail-star' }));
  const languageName = installedName(languages.active);
  replaceChildren(document.getElementById('detail-body'), detailBody(entry, details, extras, languageName));
  prefetchEntryPage(wiktionaryUrl(entry, null, languageName));
  prefetchFor([entry]);
  results.hidden = true;
  picker.hidden = true;
  libraryEl.hidden = true;
  optionsEl.hidden = true;
  detail.hidden = false;
  window.scrollTo(0, 0);
  document.body.dataset.detail = entry.simp;
  document.body.dataset.details = 'loading';
  getDetails(entry).then((full) => {
    if (stack[stack.length - 1] !== view) return;
    if (full) {
      renderPronunciation(entry, full);
      replaceChildren(document.getElementById('detail-body'), detailBody(entry, full, extras, languageName));
      prefetchEntryPage(wiktionaryUrl(entry, full, languageName));
    } else {
      offerDetails(languages.active);
    }
    document.body.dataset.details = full ? 'loaded' : 'none';
  });
}

// Without the entry pages, the detail view offers their download.
function offerDetails(code) {
  const entry = catalogueEntry(code);
  if (!entry || !entry.details || languages.hasDetails(code) || !languages.installed[code]) return;
  const key = `${code}:details`;
  const b = button(downloads.get(key) ? 'Downloading entry pages...'
    : `Download entry pages for ${entry.name} (${formatSize(entry.details.gzBytes || entry.details.bytes)})`, () => {
    b.disabled = true;
    b.textContent = 'Downloading entry pages...';
    downloadDetails(entry);
  });
  b.id = 'detail-get-pages';
  b.disabled = Boolean(downloads.get(key));
  const body = document.getElementById('detail-body');
  body.insertBefore(el('p', 'detail-offer'), body.firstChild).appendChild(b);
}

// The entry's Wiktionary (or Wikipedia) page opens in the app's panel; it
// is loaded in the background as soon as the entry page opens (prefetch
// setting), so opening it is instant. Mobile site: the same page, lighter.
function mobileUrl(url) {
  return url.replace(/^https:\/\/([a-z-]+)\.(wiktionary|wikipedia)\.org\//, 'https://$1.m.$2.org/');
}

function prefetchEntryPage(url) {
  const native = window.WiktionaryNative;
  if (native && native.prefetchPage && prefetchAllowed()) native.prefetchPage(mobileUrl(url));
}

// A Wikipedia title opens its article: in the app's panel (prefetched for
// the top result), else in a new tab. It is recorded in the history.
function articleUrl(entry) {
  return entry.url || '';
}

// Choosing a result or opening an entry closes the handwriting pad; only
// the pen opens it again.
function closePad() {
  document.getElementById('pad').hidden = true;
}

function openArticle(entry) {
  const url = articleUrl(entry);
  if (!url) return;
  closePad();
  recordView(entry, languages.active);
  const native = window.WiktionaryNative;
  if (native && native.showPage) native.showPage(mobileUrl(url));
  else window.open(url, '_blank', 'noopener');
}

function showDetail(entry, extras) {
  closePad();
  if (detail.hidden) stack.length = 0;
  recordView(entry, languages.active);
  stack.push({ entry, extras });
  history.pushState({ detail: stack.length }, '');
  renderDetail(stack[stack.length - 1]);
}

function hideDetail() {
  stack.length = 0;
  detail.hidden = true;
  picker.hidden = true;
  results.hidden = false;
  // Opened from History or Favourites: Back returns there.
  if (libraryReturn) {
    const tab = libraryReturn;
    libraryReturn = null;
    openLibrary(tab);
    return;
  }
  delete document.body.dataset.detail;
  input.focus();
}

// Hides at once so a keystroke before popstate does not go back twice.
function closeDetail() {
  const depth = (history.state && history.state.detail) || 0;
  hideDetail();
  if (depth) history.go(-depth);
}

window.addEventListener('popstate', (ev) => {
  const depth = (ev.state && ev.state.detail) || 0;
  if (depth === 0 || depth > stack.length) {
    if (depth === 0) hideDetail();
    return;
  }
  stack.length = depth;
  renderDetail(stack[depth - 1]);
});

function sameWord(a, b) {
  return a === b || a.toLowerCase() === b.toLowerCase();
}

// Entries whose headword (or traditional / alternative form) is `word`.
async function exactEntries(word) {
  if (!lookupSession) return [];
  const rows = dict && dict.blockCache ? await lookupSession.searchAsync(word, { limit: 30 }) : lookupSession.search(word, { limit: 30 });
  return rows.filter((e) => sameWord(e.simp, word) || (e.trad && sameWord(e.trad, word)));
}

function entryLabel(e) {
  return e.pinyin ? `${e.simp} ${e.pinyin}` : e.simp;
}

function others(list, chosen) {
  return list.filter((e) => e !== chosen).slice(0, MAX_OTHERS).map((e) => ({ id: e.id, label: entryLabel(e) }));
}

// A tapped character: its own entry, plus the longest entry in the
// surrounding text that covers it (offered as a chip).
async function lookupChar(chars, index) {
  const found = await exactEntries(chars[index]);
  let word = '';
  let wordChars = 1;
  for (let start = Math.max(0, index - WORD_MAX_CHARS + 1); start <= index; start++) {
    for (let end = Math.min(chars.length, start + WORD_MAX_CHARS); end > index && end - start > wordChars; end--) {
      const part = chars.slice(start, end);
      if (!part.every(isCjkChar)) continue;
      if ((await exactEntries(part.join(''))).length) {
        word = part.join('');
        wordChars = part.length;
        break;
      }
    }
  }
  if (!found.length) {
    if (word) lookupWord(word);
    else statusLine.textContent = `No entry for ${chars[index]}`;
    return;
  }
  showDetail(found[0], { word, others: others(found, found[0]) });
}

// A tapped word chip: its entry, or a search when there is none.
async function lookupWord(word) {
  const found = await exactEntries(word);
  if (found.length) {
    showDetail(found[0], { others: others(found, found[0]) });
    return;
  }
  closeDetail();
  input.value = word;
  search();
}

async function lookupId(id) {
  const top = stack[stack.length - 1];
  const word = top ? top.entry.simp : '';
  const found = await exactEntries(word);
  const e = found.find((x) => String(x.id) === String(id));
  if (e) showDetail(e, { others: others(found, e) });
}

// A lazily opened index searches asynchronously; only the latest query's
// results are shown.
let searchGen = 0;

async function search() {
  if (!detail.hidden) closeDetail();
  if (!dict) {
    if (input.value.trim() && loadingName) statusLine.textContent = `Loading ${loadingName}... results follow`;
    return;
  }
  const mine = ++searchGen;
  const t0 = performance.now();
  const rows = dict.blockCache ? await session.searchAsync(input.value, { limit: LIMIT }) : session.search(input.value, { limit: LIMIT });
  if (mine !== searchGen) return;
  const ms = performance.now() - t0;
  render(rows);
  document.body.dataset.searched = input.value;
  prefetchFor(rows);
  if (isWikipedia(languages.active) && rows.length && articleUrl(rows[0])) prefetchEntryPage(articleUrl(rows[0]));
  const s = session.lastStats;
  statusLine.textContent = input.value.trim() === ''
    ? loadInfo
    : `${rows.length} hits, ${ms.toFixed(2)} ms (${s.mode}, scanned ${s.searched})`;
}

function placeholder(code) {
  if (code === 'zh') return 'pinyin, 汉字 or English';
  if (isWikipedia(code)) return `Search ${installedName(code)} titles`;
  return `${installedName(code)} word or English`;
}

// The installed languages in the options screen (tap to switch). Kept under
// the old name: every place that changed the installed set calls it.
function renderLangSelect() {
  const rows = languages.list().map((l) => {
    const b = el('button', l.code === languages.active ? 'opt-language active' : 'opt-language');
    b.type = 'button';
    b.dataset.code = l.code;
    b.append(markElement(l.code), el('span', 'lang-name', l.name));
    if (languages.updateFor(l.code)) b.append(el('span', 'opt-update', 'update'));
    const li = el('li');
    li.appendChild(b);
    return li;
  });
  if (!rows.length) rows.push(el('li', 'opt-empty', 'No language installed yet.'));
  replaceChildren(document.getElementById('opt-languages'), ...rows);
}

// Opens `bytes` (or reads the stored index of `code`) and makes it active.
// Opening a language never blocks typing. An index the app stored as a
// file is read through HTTP Range requests on /local/: above LAZY_BYTES (and
// Wikipedia titles) it is opened lazily (only the search keys in memory,
// entries read on demand, searchAsync); below it is read progressively,
// searchable by headword before the definition tables arrive. Other
// indexes (the built-in one, browser installs) are read whole.
const LAZY_BYTES = 64 * 1048576;
let loadGen = 0;
let loadingName = '';
const loadBar = document.getElementById('load-progress');

function setLoadProgress(done, total) {
  loadBar.hidden = false;
  loadBar.max = total || 1;
  loadBar.value = Math.min(done, loadBar.max);
}

function activate(code, next, info) {
  next.inflate = inflateText;
  dict = next;
  session = dict.newSession();
  lookupSession = dict.newSession();
  languages.activate(code);
  document.body.dataset.lang = code;
  input.placeholder = placeholder(code);
  updatePen();
  if (info) loadInfo = info;
}

async function useLanguage(code, bytes) {
  const mine = ++loadGen;
  document.body.dataset.ready = 'loading';
  const name = installedName(code);
  loadingName = name;
  statusLine.textContent = `Loading ${name}...`;
  // Results of the previous language would be misleading meanwhile.
  dict = null;
  replaceChildren(results);
  const t0 = performance.now();
  const lang = languages.installed[code];
  try {
    let next;
    let size;
    let how;
    if (!bytes && lang && lang.storage === 'file') {
      const reader = await languages.fileReader(code, 'idx');
      size = reader.size;
      const lazy = size > LAZY_BYTES || lang.kind === 'wikipedia';
      const onProgress = ({ loaded, total }) => {
        if (mine === loadGen) setLoadProgress(loaded, total);
      };
      if (lazy) {
        how = 'lazily';
        next = await openIndexLazy(reader, { onProgress });
      } else {
        how = 'progressively';
        next = await openIndexProgressive(reader, {
          onProgress,
          // Headwords are searchable before the definition tables arrive.
          onSearchable: (partial) => {
            if (mine !== loadGen || partial.size === undefined) return;
            activate(code, partial);
            document.body.dataset.ready = 'partial';
            statusLine.textContent = `${name}: searching headwords, still loading...`;
            if (input.value) search();
          },
        });
      }
      if (!lazy || !lang.details || lang.details.bytes <= LAZY_BYTES) {
        const detailsBytes = await languages.readDetails(code);
        if (detailsBytes) {
          const side = deserializeIndexWithHeader(detailsBytes);
          next.attachDetails(side.sections, side.header);
        }
      }
    } else {
      const buffer = bytes || await languages.read(code);
      const detailsBytes = await languages.readDetails(code);
      size = buffer.byteLength;
      how = 'whole';
      next = openIndex(buffer, { details: detailsBytes || undefined });
    }
    if (mine !== loadGen) return;
    const ms = performance.now() - t0;
    activate(code, next, `${name}: ${next.size.toLocaleString('en')} entries, ${formatSize(size)}, opened ${how} in ${ms.toFixed(0)} ms`);
    statusLine.textContent = loadInfo;
    document.body.dataset.ready = 'true';
    document.body.dataset.opened = how;
  } catch (err) {
    if (mine !== loadGen) return;
    statusLine.textContent = `Could not load ${name}: ${err.message}`;
    document.body.dataset.ready = dict ? 'true' : 'error';
  }
  loadBar.hidden = true;
  renderLangSelect();
  if (dict) {
    input.disabled = false;
    if (input.value) search();
    else replaceChildren(results);
  }
}

// First start: the language list comes first, with Chinese (built in)
// ready to use; choosing one (or Done) shows the search screen.
const WELCOMED_KEY = 'wiktionary-lookup.welcomed';
let welcoming = false;

function openWelcome(lostBundled) {
  welcoming = true;
  document.body.dataset.screen = 'welcome';
  document.getElementById('picker-title').textContent = 'Choose a language';
  const text = document.getElementById('picker-welcome');
  if (lostBundled) {
    text.textContent = 'Chinese was built into earlier versions of the app; it is now a download like every '
      + 'other language. Download it again (or another language) to continue.';
  }
  text.hidden = false;
  openPicker();
  const problem = networkProblem();
  if (problem) pickerError(problem);
}

function endWelcome() {
  if (!welcoming) return;
  welcoming = false;
  try {
    localStorage.setItem(WELCOMED_KEY, '1');
  } catch (err) {
    // Asked again next time; harmless.
  }
  languages.save();
  document.getElementById('picker-title').textContent = 'Languages';
  document.getElementById('picker-welcome').hidden = true;
  document.body.dataset.screen = 'search';
}

// History and favourites screen.
const libraryEl = document.getElementById('library');
let libraryTab = 'history';
let libraryReturn = null;

function openLibrary(tab) {
  if (!detail.hidden) closeDetail();
  optionsEl.hidden = true;
  libraryTab = tab || libraryTab;
  results.hidden = true;
  picker.hidden = true;
  libraryEl.hidden = false;
  document.getElementById('history-pause').checked = historyPaused();
  renderLibrary();
}

function closeLibrary() {
  libraryEl.hidden = true;
  results.hidden = false;
  input.focus();
}

function libraryRow(item) {
  const li = el('li', 'library-item');
  li.dataset.key = itemKey(item);
  const info = el('div', 'library-info');
  const head = el('div');
  head.append(el('span', 'head', item.simp));
  if (item.trad) head.append(el('span', 'trad', item.trad));
  if (item.pinyin) head.append(el('span', 'pinyin', item.pinyin));
  if (item.lang !== languages.active) head.append(el('span', 'lang-code', installedName(item.lang) || item.lang));
  info.append(head, el('div', 'def', item.gloss));
  const del = el('button', 'library-delete', '×');
  del.type = 'button';
  del.title = 'Delete';
  del.setAttribute('aria-label', `Delete ${item.simp}`);
  li.append(info, del);
  return li;
}

function renderLibrary() {
  const isHistory = libraryTab === 'history';
  document.getElementById('tab-history').classList.toggle('active', isHistory);
  document.getElementById('tab-favourites').classList.toggle('active', !isHistory);
  document.getElementById('history-tools').hidden = !isHistory;
  document.getElementById('favourites-tools').hidden = isHistory;
  document.getElementById('history-confirm').hidden = true;
  document.getElementById('history-clear').hidden = false;
  const list = isHistory ? historyItems() : sortedFavourites(document.getElementById('favourites-sort').value);
  const rows = [];
  let day = '';
  for (const item of list) {
    if (isHistory) {
      const label = dayLabel(item.t);
      if (label !== day) {
        day = label;
        rows.push(el('li', 'library-day', label));
      }
    }
    rows.push(libraryRow(item));
  }
  replaceChildren(document.getElementById('library-list'), ...rows);
  document.getElementById('library-status').textContent = list.length
    ? `${list.length} ${isHistory ? 'entries' : 'favourites'}`
    : (isHistory ? (historyPaused() ? 'History is paused.' : 'No entries viewed yet.') : 'No favourites yet: tap the star on an entry.');
  document.body.dataset.library = `${libraryTab}:${list.length}`;
}

// Reopens a history or favourites item in its language (installed ones).
async function openItem(item) {
  if (item.lang !== languages.active) {
    if (!languages.installed[item.lang]) {
      document.getElementById('library-status').textContent = `${installedName(item.lang) || item.lang} is not installed`;
      return;
    }
    await useLanguage(item.lang);
  }
  const found = await exactEntries(item.simp);
  const entry = found.find((e) => (e.pinyin || '') === (item.pinyin || '')) || found[0];
  if (entry && isWikipedia(item.lang)) {
    openArticle(entry);
    return;
  }
  if (!entry) {
    document.getElementById('library-status').textContent = `${item.simp} is no longer in the dictionary`;
    return;
  }
  const tab = libraryTab;
  libraryEl.hidden = true;
  showDetail(entry, { others: others(found, entry) });
  libraryReturn = tab;
}

document.getElementById('library-close').addEventListener('click', closeLibrary);
document.getElementById('tab-history').addEventListener('click', () => openLibrary('history'));
document.getElementById('tab-favourites').addEventListener('click', () => openLibrary('favourites'));
document.getElementById('favourites-sort').addEventListener('change', renderLibrary);
document.getElementById('history-pause').addEventListener('change', (ev) => {
  setHistoryPaused(ev.target.checked);
  renderLibrary();
});
// Confirmation inside the page (the WebView shows no confirm() dialogs).
document.getElementById('history-clear').addEventListener('click', () => {
  document.getElementById('history-count').textContent = String(historyItems().length);
  document.getElementById('history-confirm').hidden = false;
  document.getElementById('history-clear').hidden = true;
});
document.getElementById('history-clear-no').addEventListener('click', renderLibrary);
document.getElementById('history-clear-yes').addEventListener('click', () => {
  clearHistory();
  renderLibrary();
});
document.getElementById('library-list').addEventListener('click', (ev) => {
  const li = ev.target.closest('li.library-item');
  if (!li) return;
  const list = libraryTab === 'history' ? historyItems() : sortedFavourites('added');
  const item = list.find((i) => itemKey(i) === li.dataset.key);
  if (!item) return;
  if (ev.target.closest('.library-delete')) {
    if (libraryTab === 'history') removeHistory(li.dataset.key);
    else removeFavourite(li.dataset.key);
    renderLibrary();
  } else {
    openItem(item);
  }
});

// Export: the app's share sheet when there is one, else the JSON text to
// copy. Import: the app's file picker, else pasted text.
function showFavouritesText(hint, text) {
  document.getElementById('favourites-text').hidden = false;
  document.getElementById('favourites-text-hint').textContent = hint;
  const area = document.getElementById('favourites-json');
  area.value = text;
  area.focus();
  area.select();
}

function importText(text) {
  try {
    const added = importFavourites(text);
    document.getElementById('favourites-text').hidden = true;
    renderLibrary();
    document.getElementById('library-status').textContent = `Imported ${added} new favourites`;
  } catch (err) {
    document.getElementById('library-status').textContent = `Import failed: ${err.message}`;
  }
}
window.onPickedText = importText;

document.getElementById('favourites-export').addEventListener('click', () => {
  const native = window.WiktionaryNative;
  const text = exportFavourites();
  if (native && native.shareText) native.shareText('wiktionary-lookup-favourites.json', text);
  else showFavouritesText('Copy this text to keep your favourites:', text);
});
document.getElementById('favourites-import').addEventListener('click', () => {
  const native = window.WiktionaryNative;
  if (native && native.pickTextFile) native.pickTextFile();
  else showFavouritesText('Paste an export here:', '');
});
document.getElementById('favourites-text-import').addEventListener('click', () => importText(document.getElementById('favourites-json').value));
document.getElementById('favourites-text-close').addEventListener('click', () => {
  document.getElementById('favourites-text').hidden = true;
});
(() => {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG_NS, 'path');
  // A gear.
  path.setAttribute('d', 'M19.14 12.94a7.07 7.07 0 0 0 0-1.88l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.61-.22l-2.39.96a7 7 0 0 0-1.63-.94l-.36-2.54A.5.5 0 0 0 13.88 2h-3.84a.5.5 0 0 0-.49.42l-.36 2.54a7 7 0 0 0-1.63.94l-2.39-.96a.5.5 0 0 0-.61.22L2.64 8.48a.5.5 0 0 0 .12.64l2.03 1.58a7.07 7.07 0 0 0 0 1.88l-2.03 1.58a.5.5 0 0 0-.12.64l1.92 3.32c.13.22.39.3.61.22l2.39-.96c.5.38 1.05.7 1.63.94l.36 2.54c.04.24.25.42.49.42h3.84c.24 0 .45-.18.49-.42l.36-2.54a7 7 0 0 0 1.63-.94l2.39.96c.22.08.48 0 .61-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58zM12 15.5A3.5 3.5 0 1 1 12 8.5a3.5 3.5 0 0 1 0 7z');
  svg.appendChild(path);
  document.getElementById('gear').insertBefore(svg, document.getElementById('lang-badge'));
})();

function openPicker() {
  libraryEl.hidden = true;
  optionsEl.hidden = true;
  if (!detail.hidden) closeDetail();
  results.hidden = true;
  picker.hidden = false;
  renderPicker();
  langFilter.focus();
  refreshCatalogue();
}

function closePicker() {
  endWelcome();
  picker.hidden = true;
  results.hidden = false;
  input.focus();
}

function catalogueEntry(code) {
  return languages.catalogue.find((l) => l.code === code) || null;
}

function progressActions(key) {
  const dl = downloads.get(key);
  const bar = el('progress');
  bar.max = dl.total || 1;
  bar.value = Math.min(dl.done, bar.max);
  return [bar, button('Cancel', () => dl.controller.abort())];
}

function pickerRow(entry) {
  const code = entry.code;
  const installed = languages.installed[code];
  const li = el('li');
  li.dataset.code = code;
  const info = el('div', 'lang-info');
  info.append(markElement(code), el('span', 'lang-name', entry.name), el('span', 'lang-code', code));
  const facts = [];
  if (entry.entries) facts.push(`${Number(entry.entries).toLocaleString('en')} entries`);
  if (entry.gzBytes || entry.bytes) facts.push(`dictionary ${formatSize(entry.gzBytes || entry.bytes)}`);
  if (entry.details) facts.push(`entry pages ${formatSize(entry.details.gzBytes || entry.details.bytes)}`);
  if (installed && installed.bundled) facts.push('built in');
  if (!installed && code === BUNDLED_CODE) facts.push('suggested');
  info.append(el('div', 'lang-facts', facts.join(', ')));
  li.append(info);

  const actions = el('div', 'lang-actions');
  if (downloads.get(code)) {
    actions.append(...progressActions(code));
  } else if (installed) {
    if (languages.active === code && !welcoming) actions.append(el('span', 'lang-active', 'Active'));
    else actions.append(button('Use', () => { closePicker(); if (code !== languages.active) useLanguage(code); }));
    const update = languages.updateFor(code);
    if (update) actions.append(button(`Update (${formatSize(update.bytes)})`, () => updateLanguage(entry)));
    if (!installed.bundled) actions.append(button('Remove', () => removeLanguage(code)));
    if (downloads.get(`${code}:details`)) {
      actions.append(...progressActions(`${code}:details`));
    } else if (entry.details && !languages.hasDetails(code)) {
      actions.append(button(`Download entry pages (${formatSize(entry.details.gzBytes || entry.details.bytes)})`,
        () => downloadDetails(entry)));
    } else if (entry.details && !installed.bundled) {
      actions.append(button('Remove entry pages', () => removeDetails(code)));
    }
  } else if (entry.url && warned.has(code)) {
    actions.append(button('Download anyway', () => { warned.delete(code); download(entry); }));
  } else if (entry.url) {
    actions.append(button(`Download dictionary (${formatSize(entry.gzBytes || entry.bytes)})`, () => {
      if (sizeWarning(entry)) {
        warned.add(code);
        updateRow(code);
      } else {
        download(entry);
      }
    }));
  }
  li.append(actions);
  if (warned.has(code)) li.append(el('p', 'lang-warning', sizeWarning(entry)));
  return li;
}

// Entry pages of an installed language: download, attach to the open
// dictionary when it is the active one, refresh an open detail view.
async function downloadDetails(entry) {
  const key = `${entry.code}:details`;
  const problem = networkProblem();
  if (problem) {
    pickerError(`${entry.name}: ${problem}`);
    return;
  }
  const controller = new AbortController();
  const state = { done: 0, total: entry.details.bytes, controller };
  downloads.set(key, state);
  updateRow(entry.code);
  breadcrumb(`download ${entry.code} entry pages start`);
  try {
    const bytes = await languages.installDetails(entry, (done, total) => {
      state.done = done;
      state.total = total;
      const bar = langList.querySelector(`li[data-code="${CSS.escape(entry.code)}"] progress`);
      if (bar) {
        bar.max = total || 1;
        bar.value = Math.min(done, bar.max);
      }
    }, controller.signal);
    downloads.delete(key);
    breadcrumb(`download ${entry.code} entry pages done`);
    if (dict && languages.active === entry.code) {
      const side = deserializeIndexWithHeader(bytes || await languages.readDetails(entry.code));
      dict.attachDetails(side.sections, side.header);
    }
    refreshUpdateMarks();
    pickerStatus.textContent = `${entry.name}: entry pages installed`;
    document.body.dataset.detailsInstalled = entry.code;
    updateRow(entry.code);
    if (stack.length) renderDetail(stack[stack.length - 1]);
  } catch (err) {
    downloads.delete(key);
    breadcrumb(`download ${entry.code} entry pages failed: ${err.message}`);
    const msg = err.name === 'AbortError' ? `${entry.name}: cancelled` : err.message;
    pickerError(msg);
    if (stack.length) statusLine.textContent = msg;
    updateRow(entry.code);
  }
}

async function removeDetails(code) {
  await languages.removeDetails(code);
  if (dict && languages.active === code) dict.details = null;
  updateRow(code);
}

// navigator.deviceMemory (GiB, rounded down, Chromium and Android WebView
// only) tells whether the index is likely to fit; without it only the size
// is shown.
function sizeWarning(entry) {
  if (!entry.bytes || entry.bytes < LARGE_INDEX_BYTES) return '';
  const need = entry.bytes * MEMORY_FACTOR;
  let text = `This index is ${formatSize(entry.bytes)} (${formatSize(entry.gzBytes || entry.bytes)} to download) `
    + `and needs about ${formatSize(need)} of memory while open.`;
  const device = navigator.deviceMemory;
  if (device && need > (device * GIB) / 4) text += ` This device reports ${device} GiB of memory; it may not open.`;
  return text;
}

function button(label, onClick) {
  const b = el('button', '', label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

function renderPicker() {
  const filter = langFilter.value.trim().toLowerCase();
  const byCode = new Map(languages.catalogue.map((l) => [l.code, l]));
  for (const l of languages.list()) if (!byCode.has(l.code)) byCode.set(l.code, l);
  const matches = [...byCode.values()]
    .filter((l) => !filter || l.name.toLowerCase().includes(filter) || l.code.toLowerCase() === filter)
    .sort((a, b) => Number(Boolean(languages.installed[b.code])) - Number(Boolean(languages.installed[a.code]))
      || Number(b.code === BUNDLED_CODE) - Number(a.code === BUNDLED_CODE)
      || (b.entries || 0) - (a.entries || 0) || a.name.localeCompare(b.name));
  const wiktionary = matches.filter((l) => !isWikipedia(l.code));
  const wikipedia = matches.filter((l) => isWikipedia(l.code));
  const rows = wiktionary.slice(0, PICKER_ROWS).map(pickerRow);
  if (wiktionary.length > PICKER_ROWS) rows.push(el('li', 'lang-more', `${wiktionary.length - PICKER_ROWS} more, type to filter`));
  // Wikipedia: article titles with short descriptions, opened as articles.
  if (wikipedia.length) rows.push(el('li', 'lang-section', 'Wikipedia'), ...wikipedia.map(pickerRow));
  replaceChildren(langList, ...rows);
}

function updateRow(code) {
  const old = langList.querySelector(`li[data-code="${CSS.escape(code)}"]`);
  const entry = languages.catalogue.find((l) => l.code === code) || languages.installed[code];
  if (old && entry) old.replaceWith(pickerRow(entry));
}

async function refreshCatalogue() {
  pickerStatus.textContent = `${languages.catalogue.length} languages (${languages.catalogueSource} list), checking for updates...`;
  try {
    await languages.refreshCatalogue();
    pickerStatus.textContent = `${languages.catalogue.length} languages available`;
    refreshUpdateMarks();
    showNetworkActions('');
  } catch (err) {
    pickerError(`${languages.catalogue.length} languages (${languages.catalogueSource} list); `
      + `could not check for updates: ${err.name === 'AbortError' ? 'timed out' : err.message}`);
  }
  if (!picker.hidden) renderPicker();
}

// Download steps go to the Android app's crash reporting as breadcrumbs.
function breadcrumb(message) {
  if (window.WiktionaryNative) window.WiktionaryNative.breadcrumb('language', message);
}

// The Android app says when it has no network at all (e.g. a per-app network
// toggle is off); the download would only fail later with a vaguer error.
function networkProblem() {
  const native = window.WiktionaryNative;
  return native && native.networkProblem ? native.networkProblem() : '';
}

// In the Android app, a "no network for this app" error offers the system
// screens where that is switched (App info; data saver when it applies).
const NO_NETWORK_MARK = 'No network for this app';
function showNetworkActions(message) {
  const native = window.WiktionaryNative;
  const show = Boolean(native && native.openAppSettings && message.indexOf(NO_NETWORK_MARK) >= 0);
  document.getElementById('network-actions').hidden = !show;
  document.getElementById('open-data-saver').hidden = !(show && native.dataSaverRestricted && native.dataSaverRestricted());
}

function pickerError(text) {
  pickerStatus.textContent = text;
  showNetworkActions(text);
}

async function download(entry) {
  const problem = networkProblem();
  if (problem) {
    breadcrumb(`download ${entry.code} skipped: no network`);
    pickerError(`${entry.name}: ${problem}`);
    return;
  }
  showNetworkActions('');
  breadcrumb(`download ${entry.code} start: ${entry.url}`);
  const controller = new AbortController();
  const state = { done: 0, total: entry.bytes, controller };
  downloads.set(entry.code, state);
  updateRow(entry.code);
  let lastPaint = 0;
  try {
    const bytes = await languages.install(entry, (done, total, phase) => {
      state.done = done;
      state.total = total;
      const bar = langList.querySelector(`li[data-code="${CSS.escape(entry.code)}"] progress`);
      if (phase === 'unpack') {
        pickerStatus.textContent = `${entry.name}: unpacking...`;
        if (bar) bar.removeAttribute('value');
      } else if (bar && performance.now() - lastPaint > 50) {
        lastPaint = performance.now();
        bar.max = total || 1;
        bar.value = Math.min(done, bar.max);
      }
    }, controller.signal);
    downloads.delete(entry.code);
    breadcrumb(`download ${entry.code} done`);
    pickerStatus.textContent = `${entry.name} installed`;
    if (!picker.hidden) closePicker();
    await useLanguage(entry.code, bytes || undefined);
    refreshUpdateMarks();
  } catch (err) {
    downloads.delete(entry.code);
    breadcrumb(`download ${entry.code} failed: ${err.message}`);
    pickerError(err.name === 'AbortError' ? `${entry.name}: cancelled` : `${entry.name}: ${err.message}`);
    updateRow(entry.code);
  }
}

// A newer data release: download what changed (the dictionary, then the
// entry pages if they were installed); the old files stay usable until the
// new ones are complete. The active language reopens afterwards.
async function updateLanguage(entry) {
  const update = languages.updateFor(entry.code);
  if (!update) return;
  const controller = new AbortController();
  const state = { done: 0, total: entry.bytes, controller };
  if (update.index) {
    downloads.set(entry.code, state);
    updateRow(entry.code);
    try {
      await languages.install(entry, (done, total) => {
        state.done = done;
        state.total = total;
        const bar = langList.querySelector(`li[data-code="${CSS.escape(entry.code)}"] progress`);
        if (bar) {
          bar.max = total || 1;
          bar.value = Math.min(done, bar.max);
        }
      }, controller.signal);
    } catch (err) {
      downloads.delete(entry.code);
      pickerError(`${entry.name}: ${err.message}`);
      updateRow(entry.code);
      return;
    }
    downloads.delete(entry.code);
  }
  if (update.details && entry.details) await downloadDetails(entry);
  if (languages.active === entry.code) await useLanguage(entry.code);
  pickerStatus.textContent = `${entry.name} updated`;
  breadcrumb(`update ${entry.code} done`);
  updateRow(entry.code);
  refreshUpdateMarks();
}

async function updateAll() {
  for (const code of Object.keys(languages.installed)) {
    const entry = catalogueEntry(code);
    if (entry && languages.updateFor(code)) await updateLanguage(entry);
  }
}

// Update marks: the "Update all" button in the language screen and a dot on
// the header switch while the active language has an update.
function refreshUpdateMarks() {
  const codes = Object.keys(languages.installed).filter((c) => languages.updateFor(c));
  const all = document.getElementById('update-all');
  const bytes = codes.reduce((sum, c) => sum + languages.updateFor(c).bytes, 0);
  all.hidden = codes.length === 0;
  all.textContent = `Update all (${codes.length}, ${formatSize(bytes)})`;
  document.getElementById('lang-badge').hidden = codes.length === 0;
  renderLangSelect();
  document.body.dataset.updates = String(codes.length);
  if (!codes.length) document.getElementById('notice').hidden = true;
  return codes;
}

// Once per app version: when some installed dictionaries have updates, say
// so under the search box with a way to the language screen.
const UPDATE_NOTE_KEY = 'wiktionary-lookup.updateNote';
function noteUpdates(codes) {
  if (!codes.length) return;
  const native = window.WiktionaryNative;
  const version = String(native && native.appVersionCode ? native.appVersionCode() : 0);
  try {
    if (localStorage.getItem(UPDATE_NOTE_KEY) === version) return;
    localStorage.setItem(UPDATE_NOTE_KEY, version);
  } catch (err) {
    return;
  }
  const notice = document.getElementById('notice');
  replaceChildren(notice, el('span', '', 'Some dictionaries have updates. '), button('Show', () => {
    notice.hidden = true;
    openOptions();
  }));
  notice.hidden = false;
}

async function removeLanguage(code) {
  const wasActive = languages.active === code;
  await languages.remove(code);
  renderPicker();
  if (wasActive) await useLanguage(languages.active);
  else renderLangSelect();
}

results.addEventListener('click', (ev) => {
  const li = ev.target.closest('li[data-index]');
  const star = ev.target.closest('button.star');
  if (li && star) {
    toggleStar(current[Number(li.dataset.index)], star);
    return;
  }
  const speak = ev.target.closest('button.speak');
  if (li && speak) {
    sayEntry(current[Number(li.dataset.index)], { kind: speak.dataset.kind });
    return;
  }
  if (li && isWikipedia(languages.active)) {
    openArticle(current[Number(li.dataset.index)]);
    return;
  }
  if (li) showDetail(current[Number(li.dataset.index)]);
});
results.addEventListener('keydown', (ev) => {
  const li = ev.target.closest('li[data-index]');
  if (li && ev.key === 'Enter') showDetail(current[Number(li.dataset.index)]);
});
document.getElementById('back').addEventListener('click', () => history.back());
detail.addEventListener('click', (ev) => {
  const top = stack[stack.length - 1];
  if (!top) return;
  const link = ev.target.closest('a.wiktionary-link');
  const native = window.WiktionaryNative;
  if (link && native && native.showPage) {
    ev.preventDefault();
    native.showPage(mobileUrl(link.href));
    return;
  }
  const ch = ev.target.closest('.ch');
  const chipEl = ev.target.closest('button.chip');
  if (ev.target.closest('#detail-speak')) {
    sayEntry(top.entry, { kind: 'audio' });
  } else if (ev.target.closest('#detail-tts')) {
    sayEntry(top.entry, { kind: 'tts' });
  } else if (ev.target.closest('#detail-star')) {
    toggleStar(top.entry, document.getElementById('detail-star'), true);
  } else if (ch) {
    const text = ch.closest('.tap-text');
    lookupChar(Array.from(text.dataset.text), Number(ch.dataset.i));
  } else if (chipEl && chipEl.dataset.id) {
    lookupId(chipEl.dataset.id);
  } else if (chipEl) {
    lookupWord(chipEl.dataset.word);
  }
});
document.getElementById('speech-settings').addEventListener('click', openSpeechSettings);
const prefetchMode = document.getElementById('prefetch-mode');
prefetchMode.value = getPrefetchMode();
prefetchMode.addEventListener('change', () => setPrefetchMode(prefetchMode.value));
document.getElementById('prefetch-setting').hidden = !(window.WiktionaryNative && window.WiktionaryNative.prefetchAudio);
document.getElementById('picker-close').addEventListener('click', closePicker);
document.getElementById('update-all').addEventListener('click', updateAll);
document.getElementById('open-app-settings').addEventListener('click', () => window.WiktionaryNative.openAppSettings());
document.getElementById('open-data-saver').addEventListener('click', () => window.WiktionaryNative.openDataSaverSettings());
input.addEventListener('input', search);
langFilter.addEventListener('input', renderPicker);
// Options: the gear in the header.
const optionsEl = document.getElementById('options');

function openOptions() {
  if (!detail.hidden) closeDetail();
  results.hidden = true;
  picker.hidden = true;
  libraryEl.hidden = true;
  optionsEl.hidden = false;
  renderLangSelect();
  document.body.dataset.screen = 'options';
}

function closeOptions() {
  optionsEl.hidden = true;
  results.hidden = false;
  document.body.dataset.screen = 'search';
  input.focus();
}

document.getElementById('gear').addEventListener('click', () => {
  if (optionsEl.hidden) openOptions();
  else closeOptions();
});
document.getElementById('options-close').addEventListener('click', closeOptions);
document.getElementById('opt-languages').addEventListener('click', (ev) => {
  const b = ev.target.closest('button.opt-language');
  if (!b) return;
  closeOptions();
  if (b.dataset.code !== languages.active) useLanguage(b.dataset.code);
});
document.getElementById('opt-more').addEventListener('click', () => {
  optionsEl.hidden = true;
  openPicker();
});
document.getElementById('opt-history').addEventListener('click', () => openLibrary('history'));
document.getElementById('opt-favourites').addEventListener('click', () => openLibrary('favourites'));
document.getElementById('opt-changelog').addEventListener('click', async () => {
  openChangelog(await loadChangelog(), Infinity);
});

// "What's new" after an update: the CHANGELOG.md sections newer than the
// version that last ran (the app reports its versionCode; a browser counts
// the newest section as current). A fresh install just records the version.
const SEEN_KEY = 'wiktionary-lookup.seenVersion';
const SECTION_RE = /^## (\S+) \(versionCode (\d+)\)/;

function parseChangelog(text) {
  const sections = [];
  for (const line of text.split('\n')) {
    const m = SECTION_RE.exec(line);
    if (m) sections.push({ name: m[1], code: Number(m[2]), items: [] });
    else if (sections.length && /^- /.test(line)) sections[sections.length - 1].items.push(line.slice(2));
  }
  return sections;
}

async function loadChangelog() {
  try {
    const res = await fetch('CHANGELOG.md');
    return res.ok ? parseChangelog(await res.text()) : [];
  } catch (err) {
    return [];
  }
}

// The whole changelog, newest first; sections newer than `seen` are marked.
function openChangelog(sections, seen, onClose) {
  document.getElementById('changelog-title').textContent = "What's new";
  replaceChildren(document.getElementById('changelog-body'), ...sections.map((sec) => {
    const block = el('section', sec.code > seen ? 'changelog-version new' : 'changelog-version');
    const list = el('ul');
    for (const item of sec.items) list.appendChild(el('li', '', item));
    block.append(el('h3', '', `Version ${sec.name}`), list);
    return block;
  }));
  const dialog = document.getElementById('changelog');
  dialog.hidden = false;
  dialog.querySelector('.dialog').scrollTop = 0;
  document.getElementById('changelog-close').onclick = () => {
    dialog.hidden = true;
    if (onClose) onClose();
  };
}

// After an update: once, the changelog with the sections since the version
// that last ran marked as new.
async function showChangelog(fresh) {
  const sections = await loadChangelog();
  if (!sections.length) return;
  const native = window.WiktionaryNative;
  const current = native && native.appVersionCode ? native.appVersionCode() : sections[0].code;
  let seen = NaN;
  try {
    seen = Number(localStorage.getItem(SEEN_KEY));
  } catch (err) {
    seen = NaN;
  }
  const remember = () => {
    try {
      localStorage.setItem(SEEN_KEY, String(current));
    } catch (err) {
      // Shown again next start; harmless.
    }
  };
  // Updated from a version before this note existed: the newest section is new.
  if (!seen) seen = fresh ? current : current - 1;
  if (!sections.some((sec) => sec.code > seen && sec.code <= current)) {
    remember();
    return;
  }
  openChangelog(sections, seen, remember);
}

// Handwriting pad (zh, ja): a pen button next to the search box opens it;
// the recognizer loads on first use. A setting hides the pen.
const PAD_KEY = 'wiktionary-lookup.pad';
const PAD_LANGUAGES = ['zh', 'ja'];
const PEN_PATH = 'M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z';
const padEl = document.getElementById('pad');
const pen = document.getElementById('pen');
let pad = null;

function padEnabled() {
  try {
    return localStorage.getItem(PAD_KEY) !== 'off';
  } catch (err) {
    return true;
  }
}

function updatePen() {
  const code = (dict && dict.language && dict.language.code) || languages.active;
  pen.hidden = !(padEnabled() && PAD_LANGUAGES.indexOf(code) >= 0);
  if (pen.hidden) padEl.hidden = true;
}

async function openPad() {
  if (!padEl.hidden) {
    padEl.hidden = true;
    return;
  }
  padEl.hidden = false;
  input.blur();
  const status = document.getElementById('pad-status');
  if (!pad) {
    status.textContent = 'Loading handwriting recognition...';
    const t0 = performance.now();
    try {
      await loadRecognizer();
    } catch (err) {
      status.textContent = err.message;
      return;
    }
    pad = new Pad({
      canvas: document.getElementById('pad-canvas'),
      candidates: document.getElementById('pad-candidates'),
      status,
      onPick: (ch) => {
        input.value += ch;
        search();
      },
    });
    status.textContent = `Draw a character (recognizer loaded in ${(performance.now() - t0).toFixed(0)} ms)`;
    document.body.dataset.pad = 'ready';
  }
  pad.resize();
}

(() => {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', PEN_PATH);
  svg.appendChild(path);
  pen.appendChild(svg);
})();
pen.addEventListener('click', openPad);
window.addEventListener('resize', () => {
  if (pad && !padEl.hidden) pad.resize();
});
document.getElementById('pad-undo').addEventListener('click', () => pad && pad.undo());
document.getElementById('pad-clear').addEventListener('click', () => pad && pad.clear());
document.getElementById('pad-close').addEventListener('click', () => {
  padEl.hidden = true;
});
const padMode = document.getElementById('pad-mode');
padMode.value = padEnabled() ? 'on' : 'off';
padMode.addEventListener('change', () => {
  try {
    localStorage.setItem(PAD_KEY, padMode.value);
  } catch (err) {
    // Applies until the page reloads.
  }
  updatePen();
});

// About: version and the third-party notices (THIRD_PARTY.md), in the
// changelog's dialog.
document.getElementById('about').addEventListener('click', async () => {
  let text = '';
  try {
    text = await (await fetch('THIRD_PARTY.md')).text();
  } catch (err) {
    text = err.message;
  }
  const native = window.WiktionaryNative;
  const version = native && native.appVersionCode ? ` (versionCode ${native.appVersionCode()})` : '';
  document.getElementById('changelog-title').textContent = `Wiktionary Lookup${version}`;
  const body = document.getElementById('changelog-body');
  // Paragraphs, with their URLs as links (opened in the browser by the app).
  replaceChildren(body, ...text.split(/\n\n+/).map((para) => {
    const p = el('p', 'about-para');
    para.replace(/^# /, '').split(/(https?:\/\/[^\s)]+)/).forEach((part, i) => {
      if (i % 2) {
        const a = el('a', '', part);
        a.href = part;
        a.target = '_blank';
        a.rel = 'noopener';
        p.appendChild(a);
      } else if (part) {
        p.appendChild(document.createTextNode(part));
      }
    });
    return p;
  }));
  body.appendChild(el('p')).appendChild(button('Changelog', async () => {
    openChangelog(await loadChangelog(), Infinity);
  })).id = 'about-changelog';
  const dialog = document.getElementById('changelog');
  dialog.hidden = false;
  document.getElementById('changelog-close').onclick = () => {
    dialog.hidden = true;
  };
});

async function start() {
  try {
    flags = await (await fetch('flags.json')).json();
  } catch (err) {
    flags = {};
  }
  // bundle.json (stage-web.js): whether there is a built-in index (with
  // pages). ?index= supplies one for tests.
  let hasIndex = Boolean(params.get('index'));
  if (!hasIndex) {
    try {
      const bundle = await (await fetch('bundle.json')).json();
      hasIndex = bundle.index !== false;
      if (bundle.details) languages.bundledDetailsUrl = 'index.details';
    } catch (err) {
      hasIndex = false;
    }
  }
  languages.setBundled(hasIndex);
  renderLangSelect();
  await languages.loadLocalCatalogue();
  renderLangSelect();
  if (languages.active) {
    await useLanguage(languages.active);
    if (!dict && languages.fallback() && languages.fallback() !== languages.active) await useLanguage(languages.fallback());
  }
  if (!dict) {
    document.body.dataset.ready = 'none';
    statusLine.textContent = 'No dictionary yet: choose a language.';
  }
  let welcomed = false;
  try {
    welcomed = localStorage.getItem(WELCOMED_KEY) === '1';
  } catch (err) {
    welcomed = true;
  }
  const fresh = languages.fresh && !welcomed;
  const nothing = !Object.keys(languages.installed).length;
  // In the background: the latest catalogue (for updates) and checksums of
  // old installs; quietly, the language screen reports errors itself.
  if (!networkProblem()) {
    languages.refreshCatalogue()
      .then(() => languages.fillMissingChecksums())
      .then(() => noteUpdates(refreshUpdateMarks()))
      .catch(() => {});
  }
  // Nothing installed (a first start, or the built-in Chinese of an earlier
  // version is gone): the language list, Chinese suggested.
  if (fresh || nothing) openWelcome(languages.lostBundled);
  else {
    document.body.dataset.screen = 'search';
    input.focus();
  }
  showChangelog(fresh);
}

start();
