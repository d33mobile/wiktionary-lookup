// About and Diagnostics texts, kept free of the page so node tests can
// check them: the version line (web/version.json, written by stage-web.js),
// the plain-text diagnostics block and the prefilled "Report a problem" link.

export const SOURCE_URL = 'https://github.com/d33mobile/wiktionary-lookup';
export const ISSUE_URL = `${SOURCE_URL}/issues/new`;
// Browsers and GitHub accept longer links, but some share targets and old
// WebViews cut them; the report link stays below this.
export const MAX_URL = 2000;
const CUT_NOTE = '(Cut to fit the link: please paste the full text from About > Diagnostics > Copy diagnostics.)';

function day(iso) {
  return typeof iso === 'string' ? iso.slice(0, 10) : '';
}

function pad2(n) {
  return n < 10 ? `0${n}` : String(n);
}

// "2026-11-16 14:05" in local time, '' for a missing or invalid date.
export function formatWhen(iso) {
  const d = new Date(iso);
  if (!iso || Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// The commit without its "-dirty" mark, or '' for a development build.
function cleanCommit(info) {
  const commit = (info && info.commit) || '';
  return /^[0-9a-f]{7,40}(-dirty)?$/.test(commit) ? commit.replace(/-dirty$/, '') : '';
}

// The public repository's page of the build's commit, or '' when there is none.
export function commitUrl(info) {
  const commit = cleanCommit(info);
  return commit ? `${SOURCE_URL}/commit/${commit}` : '';
}

// {version, code, commit, date}: the parts of "Version 0.13 (13) · <commit> ·
// <commit date>". versionCode is the installed app's (Android) when given.
export function versionParts(info, versionCode) {
  const i = info || {};
  return {
    version: i.version || '',
    code: versionCode || i.versionCode || 0,
    commit: i.commit || 'dev',
    date: day(i.committed),
  };
}

export function versionLine(info, versionCode) {
  const p = versionParts(info, versionCode);
  const head = `Version ${p.version || '?'}${p.code ? ` (${p.code})` : ''}`;
  return [head, p.commit, p.date].filter(Boolean).join(' · ');
}

// "Android 9" from a user agent, '' when it names no Android version.
export function androidVersion(userAgent) {
  const m = /Android (\d+(?:\.\d+)*)/.exec(userAgent || '');
  return m ? `Android ${m[1]}` : '';
}

export function webViewVersion(userAgent) {
  const m = /Chrome\/(\S+)/.exec(userAgent || '');
  return m ? `Chrome ${m[1]}` : (userAgent || 'unknown');
}

// One installed dictionary: "Chinese (zh, active): data of 2026-11-06, extract
// 2026-10-30, 12.3 MiB, entry pages; update available".
export function dictionaryLine(d, formatSize) {
  const tags = [d.code];
  if (d.active) tags.push('active');
  if (d.bundled) tags.push('built in');
  const facts = [];
  facts.push(d.generated ? `data of ${day(d.generated)}` : 'data date unknown');
  if (d.extracted) facts.push(`extract ${day(d.extracted)}`);
  if (d.bytes) facts.push(formatSize(d.bytes));
  if (d.details) facts.push('entry pages');
  return `${d.name} (${tags.join(', ')}): ${facts.join(', ')}${d.update ? '; update available' : ''}`;
}

// "Data catalogue: 2026-11-06 (latest list), checked 2026-11-16 14:05".
export function catalogueLine(c) {
  const date = c && c.generated ? day(c.generated) : 'unknown';
  const source = c && c.source && c.source !== 'none' ? ` (${c.source === 'remote' ? 'latest' : c.source} list)` : '';
  const checked = c && c.checked ? formatWhen(c.checked) : '';
  return `Data catalogue: ${date}${source}, ${checked ? `checked ${checked}` : 'not checked yet'}`;
}

// The plain-text block shown in Diagnostics and copied by "Copy diagnostics":
// {info, versionCode, userAgent, dictionaries, catalogue, settings, lines, lastError}.
export function diagnosticsText(d, formatSize) {
  const out = [`Wiktionary Lookup ${versionLine(d.info, d.versionCode)}`];
  const android = androidVersion(d.userAgent);
  out.push(`${android ? `${android}, ` : ''}WebView ${webViewVersion(d.userAgent)}`);
  out.push('Dictionaries:');
  if (d.dictionaries && d.dictionaries.length) {
    for (const x of d.dictionaries) out.push(`  ${dictionaryLine(x, formatSize)}`);
  } else {
    out.push('  none installed');
  }
  out.push(catalogueLine(d.catalogue));
  if (d.settings) out.push(`Settings: ${d.settings}`);
  for (const line of d.lines || []) out.push(line);
  out.push(`Last error: ${d.lastError || 'none'}`);
  return out.join('\n');
}

function reportUrl(title, body) {
  return `${ISSUE_URL}?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
}

// The new-issue page with the title and the diagnostics filled in, below
// maxLength characters: diagnostics lines are dropped from the end (with a
// note asking for the copied text) until the link fits.
export function issueUrl(diagnostics, info, maxLength = MAX_URL) {
  const version = info && info.version ? ` ${info.version}` : '';
  const title = `Problem in Wiktionary Lookup${version}`;
  const intro = 'What happened, and what did you expect?\n\n\n\nDiagnostics:\n';
  let lines = diagnostics.split('\n');
  let url = reportUrl(title, `${intro}${lines.join('\n')}\n`);
  if (url.length < maxLength) return url;
  while (lines.length) {
    lines = lines.slice(0, -1);
    url = reportUrl(title, `${intro}${lines.join('\n')}\n${CUT_NOTE}\n`);
    if (url.length < maxLength) return url;
  }
  return url;
}
