// Viewing history and favourites, kept in localStorage (they survive app
// updates and index updates: an item names its language, headword and
// reading rather than an entry id).
//
// item: {lang, simp, trad, pinyin, gloss, t}; history is newest first,
// capped, one item per entry (the latest view); favourites keep the time
// they were added.

const HISTORY_KEY = 'wiktionary-lookup.history';
const FAVOURITES_KEY = 'wiktionary-lookup.favourites';
const PAUSE_KEY = 'wiktionary-lookup.historyPaused';
export const HISTORY_MAX = 2000;
const GLOSS_CHARS = 90;

function load(key) {
  try {
    const v = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(v) ? v : [];
  } catch (err) {
    return [];
  }
}

function store(key, list) {
  try {
    localStorage.setItem(key, JSON.stringify(list));
    return true;
  } catch (err) {
    return false;
  }
}

export function itemKey(item) {
  return `${item.lang}|${item.simp}|${item.pinyin || ''}`;
}

export function itemOf(entry, lang, now) {
  const gloss = entry.definition.split('/').filter(Boolean).join('; ');
  return {
    lang,
    simp: entry.simp,
    trad: entry.trad && entry.trad !== entry.simp ? entry.trad : '',
    pinyin: entry.pinyin || '',
    gloss: gloss.length > GLOSS_CHARS ? `${gloss.slice(0, GLOSS_CHARS - 1)}…` : gloss,
    t: now || Date.now(),
  };
}

export function historyPaused() {
  try {
    return localStorage.getItem(PAUSE_KEY) === '1';
  } catch (err) {
    return false;
  }
}

export function setHistoryPaused(paused) {
  try {
    localStorage.setItem(PAUSE_KEY, paused ? '1' : '0');
  } catch (err) {
    // Applies until the page reloads.
  }
}

export function history() {
  return load(HISTORY_KEY);
}

export function recordView(entry, lang) {
  if (historyPaused()) return;
  const item = itemOf(entry, lang);
  const key = itemKey(item);
  const list = history().filter((i) => itemKey(i) !== key);
  list.unshift(item);
  store(HISTORY_KEY, list.slice(0, HISTORY_MAX));
}

export function removeHistory(key) {
  store(HISTORY_KEY, history().filter((i) => itemKey(i) !== key));
}

export function clearHistory() {
  store(HISTORY_KEY, []);
}

export function favourites() {
  return load(FAVOURITES_KEY);
}

export function isFavourite(entry, lang) {
  const key = itemKey(itemOf(entry, lang));
  return favourites().some((i) => itemKey(i) === key);
}

// Adds or removes; returns whether the entry is a favourite now.
export function toggleFavourite(entry, lang) {
  const item = itemOf(entry, lang);
  const key = itemKey(item);
  const list = favourites();
  const kept = list.filter((i) => itemKey(i) !== key);
  if (kept.length === list.length) {
    kept.unshift(item);
    store(FAVOURITES_KEY, kept);
    return true;
  }
  store(FAVOURITES_KEY, kept);
  return false;
}

export function removeFavourite(key) {
  store(FAVOURITES_KEY, favourites().filter((i) => itemKey(i) !== key));
}

export function sortedFavourites(order) {
  const list = favourites();
  if (order === 'headword') list.sort((a, b) => a.simp.localeCompare(b.simp) || a.pinyin.localeCompare(b.pinyin));
  else list.sort((a, b) => b.t - a.t);
  return list;
}

// The settings an export carries (since 0.13) and their valid values;
// historyPaused is a boolean.
export const SETTING_VALUES = { prefetch: ['always', 'wifi', 'off'], pad: ['on', 'off'] };

// settings: {prefetch, pad, historyPaused}, kept next to the favourites.
export function exportFavourites(settings) {
  const data = { format: 'wiktionary-lookup-favourites', version: 1, favourites: favourites() };
  if (settings) data.settings = settings;
  return JSON.stringify(data, null, 1);
}

// The settings in an export, the known ones with valid values only; null
// when there are none (exports before 0.13, a plain array, broken JSON).
export function settingsOf(text) {
  let data = null;
  try {
    data = JSON.parse(text);
  } catch (err) {
    return null;
  }
  const s = data && !Array.isArray(data) ? data.settings : null;
  if (!s || typeof s !== 'object') return null;
  const out = {};
  for (const key of Object.keys(SETTING_VALUES)) {
    if (SETTING_VALUES[key].indexOf(s[key]) >= 0) out[key] = s[key];
  }
  if (typeof s.historyPaused === 'boolean') out.historyPaused = s.historyPaused;
  return Object.keys(out).length ? out : null;
}

// Merges an export (or a plain array of items); returns how many were new.
export function importFavourites(text) {
  const data = JSON.parse(text);
  const incoming = Array.isArray(data) ? data : data && data.favourites;
  if (!Array.isArray(incoming)) throw new Error('not a favourites export');
  const list = favourites();
  const keys = new Set(list.map(itemKey));
  let added = 0;
  for (const i of incoming) {
    if (!i || typeof i.simp !== 'string' || typeof i.lang !== 'string') continue;
    const item = { lang: i.lang, simp: i.simp, trad: i.trad || '', pinyin: i.pinyin || '', gloss: i.gloss || '', t: Number(i.t) || Date.now() };
    if (keys.has(itemKey(item))) continue;
    keys.add(itemKey(item));
    list.push(item);
    added++;
  }
  list.sort((a, b) => b.t - a.t);
  store(FAVOURITES_KEY, list);
  return added;
}

// "Today", "Yesterday" or the date, for grouping by day.
export function dayLabel(t, now) {
  const day = (x) => {
    const d = new Date(x);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  };
  const diff = Math.round((day(now || Date.now()) - day(t)) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return new Date(t).toLocaleDateString('en', { year: 'numeric', month: 'short', day: 'numeric' });
}
