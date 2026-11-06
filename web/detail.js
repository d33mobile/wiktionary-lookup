// Detail screen in the style of a Wiktionary entry: headword, pronunciation,
// one section per part of speech with numbered senses and their examples,
// forms, etymology, related words as chips and a link to the page.
//
// The content comes from the index's optional details payload
// (await dict.getDetails(id): {title, records: [{pos, senses: [{gloss,
// examples: [{text, roman, english}], links: [[text, word]]}], etymology, forms: [{form, tags}],
// sounds: [{text, kind, tags}], synonyms, antonyms, related, derived:
// [{word, roman, sense}]}]}, see README); without it the entry's own
// definition is shown. CJK
// characters in the text are tap targets (span.ch, with the surrounding
// text in data-text of the closest .tap-text), words in lists are chips
// (button.chip with data-word), words a gloss links to are a.word-link
// with data-word; app.js handles the taps.

const CJK_CHAR_RE = /^(?:[々〇㐀-䶿一-鿿豈-﫿]|[\uD840-\uD8BF][\uDC00-\uDFFF])$/;
const WIKTIONARY = 'https://en.wiktionary.org/wiki/';
const POS_NAMES = {
  noun: 'Noun', verb: 'Verb', adj: 'Adjective', adv: 'Adverb', intj: 'Interjection', pron: 'Pronoun',
  prep: 'Preposition', conj: 'Conjunction', num: 'Numeral', name: 'Proper noun', particle: 'Particle',
  classifier: 'Classifier', character: 'Character', phrase: 'Phrase', proverb: 'Proverb', idiom: 'Idiom',
  suffix: 'Suffix', prefix: 'Prefix', affix: 'Affix', det: 'Determiner', article: 'Article',
  postp: 'Postposition', abbrev: 'Abbreviation', symbol: 'Symbol', contraction: 'Contraction',
};
const RELATED = [['synonyms', 'Synonyms'], ['antonyms', 'Antonyms'], ['related', 'Related terms'],
  ['derived', 'Derived terms'], ['coordinate', 'Coordinate terms']];

export function isCjkChar(ch) {
  return CJK_CHAR_RE.test(ch);
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// Appends text to node with its CJK characters as tap targets; first is the
// index of its first character in the node's data-text.
function appendTapRun(node, text, first) {
  let run = '';
  Array.from(text).forEach((ch, i) => {
    if (!isCjkChar(ch)) {
      run += ch;
      return;
    }
    if (run) node.appendChild(document.createTextNode(run));
    run = '';
    const span = el('span', 'ch', ch);
    span.dataset.i = String(first + i);
    node.appendChild(span);
  });
  if (run) node.appendChild(document.createTextNode(run));
}

// Text whose CJK characters are tap targets.
export function tapText(tag, className, text) {
  const node = el(tag, className ? `${className} tap-text` : 'tap-text');
  node.dataset.text = text || '';
  appendTapRun(node, text || '', 0);
  return node;
}

// [{start, end, word}] of the links ([text, word]) in text: the first
// occurrence of each text that overlaps no other, longest texts first so a
// shorter link never cuts a longer one; ordered by start.
export function linkRanges(text, links) {
  const ranges = [];
  const sorted = (links || []).filter((l) => Array.isArray(l) && l[0] && l[1])
    .sort((a, b) => b[0].length - a[0].length);
  for (const [linkText, word] of sorted) {
    let at = text.indexOf(linkText);
    while (at >= 0 && ranges.some((r) => at < r.end && at + linkText.length > r.start)) {
      at = text.indexOf(linkText, at + 1);
    }
    if (at >= 0) ranges.push({ start: at, end: at + linkText.length, word });
  }
  return ranges.sort((a, b) => a.start - b.start);
}

// A gloss: its links (sense.links) are a.word-link with data-word, the rest
// is tap text.
export function glossText(text, links) {
  const node = el('span', 'gloss tap-text');
  node.dataset.text = text;
  let pos = 0;
  let chars = 0;
  const plain = (end) => {
    const part = text.slice(pos, end);
    appendTapRun(node, part, chars);
    chars += Array.from(part).length;
  };
  for (const r of linkRanges(text, links)) {
    plain(r.start);
    const part = text.slice(r.start, r.end);
    const a = el('a', 'word-link', part);
    a.href = '#';
    a.dataset.word = r.word;
    node.appendChild(a);
    chars += Array.from(part).length;
    pos = r.end;
  }
  plain(text.length);
  return node;
}

export function chip(word, className) {
  const b = el('button', className ? `chip ${className}` : 'chip', word);
  b.type = 'button';
  b.dataset.word = word;
  return b;
}

function posName(pos) {
  const key = String(pos || '').toLowerCase();
  if (POS_NAMES[key]) return POS_NAMES[key];
  return key ? key.replace(/^./, (c) => c.toUpperCase()) : '';
}

// "(noun) (literary) house" -> {pos: 'noun', gloss: '(literary) house'}
function splitPos(sense) {
  const m = /^\(([a-z ]+)\)\s*/.exec(sense);
  return m && POS_NAMES[m[1]] !== undefined ? { pos: m[1], gloss: sense.slice(m[0].length) } : { pos: '', gloss: sense };
}

// Sections from the details payload, or from the definition ("(pos) a/(pos) b").
export function sectionsOf(entry, details) {
  if (details && Array.isArray(details.records) && details.records.length) return details.records;
  const sections = [];
  for (const sense of entry.definition.split('/').filter(Boolean)) {
    const { pos, gloss } = splitPos(sense);
    let section = sections[sections.length - 1];
    if (!section || (pos && section.pos !== pos)) {
      section = { pos, senses: [] };
      sections.push(section);
    }
    section.senses.push({ gloss });
  }
  return sections;
}

function heading(text) {
  return el('h3', 'detail-h', text);
}

function senseItem(sense) {
  const li = el('li', 'sense');
  if (sense.tags && sense.tags.length) li.appendChild(el('span', 'sense-tags', `(${sense.tags.join(', ')}) `));
  li.appendChild(glossText(sense.gloss || '', sense.links));
  if (sense.examples && sense.examples.length) {
    const ul = el('ul', 'examples');
    for (const ex of sense.examples) {
      const item = el('li', 'example');
      item.appendChild(tapText('div', 'ex-text', ex.text || ''));
      if (ex.roman) item.appendChild(el('div', 'ex-roman', ex.roman));
      if (ex.english) item.appendChild(el('div', 'ex-trans', ex.english));
      ul.appendChild(item);
    }
    li.appendChild(ul);
  }
  return li;
}

function wordChip(w) {
  // Some extracted words end in a stray opening parenthesis ("您好 (").
  const word = (typeof w === 'string' ? w : w.word).replace(/\s*[(（]\s*$/, '');
  const c = chip(word);
  const note = typeof w === 'string' ? '' : [w.roman, w.sense].filter(Boolean).join(', ');
  if (note) c.title = note;
  return c;
}

function relatedBlocks(record) {
  const frag = document.createDocumentFragment();
  for (const [key, label] of RELATED) {
    const words = record[key];
    if (!words || !words.length) continue;
    const chips = el('div', `chips related-${key}`);
    for (const w of words) chips.appendChild(wordChip(w));
    frag.append(el('h4', 'detail-h4', label), chips);
  }
  return frag;
}

function formsTable(forms) {
  const table = el('table', 'forms');
  for (const f of forms) {
    const tr = el('tr');
    const word = el('td', 'form');
    word.appendChild(chip(f.form, 'form-chip'));
    tr.append(word, el('td', 'form-tags', (f.tags || []).join(', ')));
    table.appendChild(tr);
  }
  return table;
}

export function wiktionaryUrl(entry, details, languageName) {
  // Indexes of other sources give each entry its own page (header entryUrl).
  if (entry.url) return entry.url;
  const title = (details && details.title) || entry.simp;
  const anchor = languageName ? `#${encodeURIComponent(languageName.replace(/ /g, '_'))}` : '';
  return WIKTIONARY + encodeURIComponent(title.replace(/ /g, '_')) + anchor;
}

// -> DocumentFragment with everything below the pronunciation line.
export function detailBody(entry, details, extras, languageName) {
  const frag = document.createDocumentFragment();
  if (extras && (extras.word || (extras.others && extras.others.length))) {
    const nav = el('div', 'chips lookup-extras');
    if (extras.word) nav.append(el('span', 'chips-label', 'In this text:'), chip(extras.word, 'word-chip'));
    if (extras.others && extras.others.length) {
      nav.appendChild(el('span', 'chips-label', 'Other entries:'));
      for (const o of extras.others) nav.appendChild(chip(o.label, 'other-chip')).dataset.id = String(o.id);
    }
    frag.appendChild(nav);
  }
  const sections = sectionsOf(entry, details);
  // One etymology for all records goes first, as its own section; several
  // differing ones stay with their records, as on Wiktionary.
  const etymologies = sections.map((r) => r.etymology || '').filter(Boolean);
  const shared = etymologies.length && etymologies.every((e) => e === etymologies[0]) ? etymologies[0] : '';
  if (shared) frag.append(heading('Etymology'), tapText('p', 'etymology', shared));
  const container = el('div', '');
  container.id = 'detail-senses';
  for (const section of sections) {
    const block = el('section', 'pos-section');
    if (!shared && section.etymology) {
      block.append(el('h4', 'detail-h4', 'Etymology'), tapText('p', 'etymology', section.etymology));
    }
    if (section.pos) block.appendChild(heading(posName(section.pos)));
    const ol = el('ol', 'senses');
    for (const sense of section.senses || []) ol.appendChild(senseItem(sense));
    block.appendChild(ol);
    if (section.forms && section.forms.length) {
      block.append(el('h4', 'detail-h4', 'Forms'), formsTable(section.forms));
    }
    block.appendChild(relatedBlocks(section));
    container.appendChild(block);
  }
  frag.appendChild(container);
  const url = wiktionaryUrl(entry, details, languageName);
  const site = /wikipedia\.org/.test(url) ? 'Wikipedia' : 'Wiktionary';
  const link = el('a', 'wiktionary-link', `Open on ${site}`);
  link.href = url;
  link.target = '_blank';
  link.rel = 'noopener';
  frag.appendChild(link);
  return frag;
}

// Pronunciation lines: [label, text] pairs from the records' sounds (one
// line per distinct reading, "Mandarin · Pinyin: nǐ hǎo"), with the entry's
// own romanization first when no sound has it.
const MAX_PRON_LINES = 8;

function soundLabel(sound) {
  if (sound.kind === 'ipa') return sound.tags && sound.tags.length ? `IPA (${sound.tags.join(', ')})` : 'IPA';
  if (sound.tags && sound.tags.length) return sound.tags.join(' · ');
  return sound.kind === 'enpr' ? 'enPR' : '';
}

export function pronunciationLines(entry, details, romanLabel) {
  const seen = new Set();
  const sounds = [];
  for (const r of (details && details.records) || []) {
    for (const snd of r.sounds || []) {
      const key = `${snd.kind}|${snd.text}|${(snd.tags || []).join(',')}`;
      if (!snd.text || seen.has(key)) continue;
      seen.add(key);
      sounds.push(snd);
    }
  }
  const lines = [];
  const plain = (t) => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z]/gi, '').toLowerCase();
  const roman = entry.pinyin ? plain(entry.pinyin.replace(/[0-9]/g, '')) : '';
  if (entry.pinyin && !sounds.some((snd) => plain(snd.text) === roman)) lines.push([romanLabel, entry.pinyin]);
  for (const snd of sounds.slice(0, MAX_PRON_LINES)) lines.push([soundLabel(snd), snd.text]);
  return lines;
}
