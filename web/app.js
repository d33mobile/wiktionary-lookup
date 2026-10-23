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
import { deserializeIndexWithHeader } from '../lib/index-format.js';
import { BUNDLED_CODE, inflateText, Languages, releasesBase } from './languages.js';
import {
  getMode, getPrefetchMode, openSpeechSettings, pronounce, setMode, setPrefetchMode,
} from './pronounce.js';
import { detailBody, isCjkChar, pronunciationLines, tapText } from './detail.js';
import { loadRecognizer, Pad } from './handwriting.js';

const LIMIT = 50;
const PICKER_ROWS = 200;
const MORE = '__more';
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
const langSelect = document.getElementById('lang');
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

// In the result list: the speaker only for entries with a recording; with
// "Always text-to-speech", the text-to-speech button on every row instead.
function rowSpeakButton(entry) {
  if (getMode() === 'speech') return speakButton('tts');
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
    Object.assign(speakButton('tts', true), { id: 'detail-tts' }));
  const languageName = installedName(languages.active);
  replaceChildren(document.getElementById('detail-body'), detailBody(entry, details, extras, languageName));
  prefetchFor([entry]);
  results.hidden = true;
  picker.hidden = true;
  detail.hidden = false;
  window.scrollTo(0, 0);
  document.body.dataset.detail = entry.simp;
  document.body.dataset.details = 'loading';
  getDetails(entry).then((full) => {
    if (stack[stack.length - 1] !== view) return;
    if (full) {
      renderPronunciation(entry, full);
      replaceChildren(document.getElementById('detail-body'), detailBody(entry, full, extras, languageName));
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

function showDetail(entry, extras) {
  if (detail.hidden) stack.length = 0;
  stack.push({ entry, extras });
  history.pushState({ detail: stack.length }, '');
  renderDetail(stack[stack.length - 1]);
}

function hideDetail() {
  stack.length = 0;
  detail.hidden = true;
  picker.hidden = true;
  results.hidden = false;
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
function exactEntries(word) {
  if (!lookupSession) return [];
  return lookupSession.search(word, { limit: 30 }).filter((e) => sameWord(e.simp, word) || (e.trad && sameWord(e.trad, word)));
}

function entryLabel(e) {
  return e.pinyin ? `${e.simp} ${e.pinyin}` : e.simp;
}

function others(list, chosen) {
  return list.filter((e) => e !== chosen).slice(0, MAX_OTHERS).map((e) => ({ id: e.id, label: entryLabel(e) }));
}

// A tapped character: its own entry, plus the longest entry in the
// surrounding text that covers it (offered as a chip).
function lookupChar(chars, index) {
  const found = exactEntries(chars[index]);
  let word = '';
  let wordChars = 1;
  for (let start = Math.max(0, index - WORD_MAX_CHARS + 1); start <= index; start++) {
    for (let end = Math.min(chars.length, start + WORD_MAX_CHARS); end > index && end - start > wordChars; end--) {
      const part = chars.slice(start, end);
      if (!part.every(isCjkChar)) continue;
      if (exactEntries(part.join('')).length) {
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
function lookupWord(word) {
  const found = exactEntries(word);
  if (found.length) {
    showDetail(found[0], { others: others(found, found[0]) });
    return;
  }
  closeDetail();
  input.value = word;
  search();
}

function lookupId(id) {
  const top = stack[stack.length - 1];
  const word = top ? top.entry.simp : '';
  const found = exactEntries(word);
  const e = found.find((x) => String(x.id) === String(id));
  if (e) showDetail(e, { others: others(found, e) });
}

function search() {
  if (!dict) return;
  if (!detail.hidden) closeDetail();
  const t0 = performance.now();
  const rows = session.search(input.value, { limit: LIMIT });
  const ms = performance.now() - t0;
  render(rows);
  prefetchFor(rows);
  const s = session.lastStats;
  statusLine.textContent = input.value.trim() === ''
    ? loadInfo
    : `${rows.length} hits, ${ms.toFixed(2)} ms (${s.mode}, scanned ${s.searched})`;
}

function placeholder(code) {
  if (code === 'zh') return 'pinyin, 汉字 or English';
  return `${installedName(code)} word or English`;
}

function renderLangSelect() {
  const options = languages.list().map((l) => {
    const o = el('option', '', `${languageMark(l.code).text} ${l.name}`);
    o.value = l.code;
    return o;
  });
  const more = el('option', '', 'More languages...');
  more.value = MORE;
  replaceChildren(langSelect, ...options, more);
  langSelect.value = languages.active;
}

// Opens `bytes` (or reads the stored index of `code`) and makes it active.
async function useLanguage(code, bytes) {
  input.disabled = true;
  document.body.dataset.ready = 'loading';
  const name = installedName(code);
  statusLine.textContent = `Loading ${name}...`;
  const t0 = performance.now();
  try {
    const buffer = bytes || await languages.read(code);
    const detailsBytes = await languages.readDetails(code);
    const t1 = performance.now();
    const next = openIndex(buffer, { details: detailsBytes || undefined });
    const t2 = performance.now();
    languages.activate(code);
    next.inflate = inflateText;
    dict = next;
    session = dict.newSession();
    lookupSession = dict.newSession();
    loadInfo = `${name}: ${dict.size.toLocaleString('en')} entries, ${formatSize(buffer.byteLength)}, `
      + `read in ${(t1 - t0).toFixed(0)} ms, opened in ${(t2 - t1).toFixed(0)} ms`;
    statusLine.textContent = loadInfo;
    document.body.dataset.lang = code;
    updatePen();
    document.body.dataset.ready = 'true';
    input.placeholder = placeholder(code);
  } catch (err) {
    statusLine.textContent = `Could not load ${name}: ${err.message}`;
    document.body.dataset.ready = dict ? 'true' : 'error';
  }
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

function openWelcome() {
  welcoming = true;
  document.body.dataset.screen = 'welcome';
  document.getElementById('picker-title').textContent = 'Choose a language';
  document.getElementById('picker-welcome').hidden = false;
  openPicker();
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

function openPicker() {
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
  info.append(el('div', 'lang-facts', facts.join(', ')));
  li.append(info);

  const actions = el('div', 'lang-actions');
  if (downloads.get(code)) {
    actions.append(...progressActions(code));
  } else if (installed) {
    if (languages.active === code && !welcoming) actions.append(el('span', 'lang-active', 'Active'));
    else actions.append(button('Use', () => { closePicker(); if (code !== languages.active) useLanguage(code); }));
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
      const side = deserializeIndexWithHeader(bytes);
      dict.attachDetails(side.sections, side.header);
    }
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
      || (b.entries || 0) - (a.entries || 0) || a.name.localeCompare(b.name));
  const rows = matches.slice(0, PICKER_ROWS).map(pickerRow);
  if (matches.length > PICKER_ROWS) rows.push(el('li', 'lang-more', `${matches.length - PICKER_ROWS} more, type to filter`));
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
    breadcrumb(`download ${entry.code} done: ${bytes.byteLength} bytes`);
    pickerStatus.textContent = `${entry.name} installed`;
    if (!picker.hidden) closePicker();
    await useLanguage(entry.code, bytes);
  } catch (err) {
    downloads.delete(entry.code);
    breadcrumb(`download ${entry.code} failed: ${err.message}`);
    pickerError(err.name === 'AbortError' ? `${entry.name}: cancelled` : `${entry.name}: ${err.message}`);
    updateRow(entry.code);
  }
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
  const speak = ev.target.closest('button.speak');
  if (li && speak) {
    sayEntry(current[Number(li.dataset.index)], { kind: speak.dataset.kind });
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
  const ch = ev.target.closest('.ch');
  const chipEl = ev.target.closest('button.chip');
  if (ev.target.closest('#detail-speak')) {
    sayEntry(top.entry, { kind: 'audio' });
  } else if (ev.target.closest('#detail-tts')) {
    sayEntry(top.entry, { kind: 'tts' });
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
const pronMode = document.getElementById('pron-mode');
pronMode.value = getMode();
pronMode.addEventListener('change', () => {
  setMode(pronMode.value);
  if (input.value) search();
});
document.getElementById('picker-close').addEventListener('click', closePicker);
document.getElementById('open-app-settings').addEventListener('click', () => window.WiktionaryNative.openAppSettings());
document.getElementById('open-data-saver').addEventListener('click', () => window.WiktionaryNative.openDataSaverSettings());
input.addEventListener('input', search);
langFilter.addEventListener('input', renderPicker);
langSelect.addEventListener('change', () => {
  const code = langSelect.value;
  if (code === MORE) {
    langSelect.value = languages.active;
    openPicker();
  } else if (code !== languages.active) {
    useLanguage(code);
  }
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

async function showChangelog(fresh) {
  let sections;
  try {
    const res = await fetch('CHANGELOG.md');
    sections = res.ok ? parseChangelog(await res.text()) : [];
  } catch (err) {
    sections = [];
  }
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
  // Updated from a version before this note existed: show the newest section.
  if (!seen) seen = fresh ? current : current - 1;
  const fresh_ = sections.filter((s) => s.code > seen && s.code <= current);
  if (!fresh_.length) {
    remember();
    return;
  }
  const body = document.getElementById('changelog-body');
  replaceChildren(body, ...fresh_.map((sec) => {
    const block = el('section', 'changelog-version');
    const list = el('ul');
    for (const item of sec.items) list.appendChild(el('li', '', item));
    block.append(el('h3', '', `Version ${sec.name}`), list);
    return block;
  }));
  const dialog = document.getElementById('changelog');
  dialog.hidden = false;
  document.getElementById('changelog-close').onclick = () => {
    dialog.hidden = true;
    remember();
  };
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
  if (!params.get('index')) {
    try {
      const bundle = await (await fetch('bundle.json')).json();
      if (bundle.details) languages.bundledDetailsUrl = 'index.details';
    } catch (err) {
      // No bundle description: the built-in index has no separate pages.
    }
  }
  renderLangSelect();
  await languages.loadLocalCatalogue();
  renderLangSelect();
  await useLanguage(languages.active);
  if (!dict) await useLanguage(BUNDLED_CODE);
  let welcomed = false;
  try {
    welcomed = localStorage.getItem(WELCOMED_KEY) === '1';
  } catch (err) {
    welcomed = true;
  }
  const fresh = languages.fresh && !welcomed;
  if (fresh) openWelcome();
  else {
    document.body.dataset.screen = 'search';
    input.focus();
  }
  showChangelog(fresh);
}

start();
