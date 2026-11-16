// web/about.js: the version line, the diagnostics text and the prefilled
// problem report link.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  androidVersion, catalogueLine, commitUrl, diagnosticsText, dictionaryLine, formatWhen, ISSUE_URL, issueUrl, MAX_URL,
  SOURCE_URL, versionLine,
} from '../web/about.js';
import { SOURCE_URL as STAGED_SOURCE } from '../stage-web.js';

const INFO = { version: '0.13', versionCode: 13, commit: '0123456789ab', committed: '2026-11-16T23:23:06+01:00', source: SOURCE_URL };
const UA = 'Mozilla/5.0 (Linux; Android 9; AOSP on IA Emulator Build/PSR1.180720.117; wv) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Version/4.0 Chrome/66.0.3359.158 Mobile Safari/537.36';
const size = (n) => `${(n / 1048576).toFixed(1)} MiB`;

test('the version line and the commit link point at the public repository', () => {
  assert.equal(SOURCE_URL, STAGED_SOURCE);
  assert.equal(versionLine(INFO), 'Version 0.13 (13) · 0123456789ab · 2026-11-16');
  assert.equal(versionLine(INFO, 14), 'Version 0.13 (14) · 0123456789ab · 2026-11-16', 'the installed versionCode wins');
  assert.equal(commitUrl(INFO), 'https://github.com/d33mobile/wiktionary-lookup/commit/0123456789ab');
  assert.equal(commitUrl({ ...INFO, commit: '0123456789ab-dirty' }), 'https://github.com/d33mobile/wiktionary-lookup/commit/0123456789ab');
  assert.equal(commitUrl({ commit: 'dev' }), '');
  assert.equal(commitUrl({}), '');
  assert.equal(versionLine({}), 'Version ? · dev');
});

test('dictionary and catalogue lines', () => {
  assert.equal(dictionaryLine({
    code: 'zh', name: 'Chinese', active: true, generated: '2026-11-06T11:54:39.439Z', extracted: '2026-10-30',
    bytes: 25 * 1048576, details: true, update: true,
  }, size), 'Chinese (zh, active): data of 2026-11-06, extract 2026-10-30, 25.0 MiB, entry pages; update available');
  assert.equal(dictionaryLine({ code: 'de', name: 'German' }, size), 'German (de): data date unknown');
  assert.match(catalogueLine({ generated: '2026-11-06T11:54:39.439Z', source: 'remote', checked: '2026-11-16T13:05:00.000Z' }),
    /^Data catalogue: 2026-11-06 \(latest list\), checked 2026-11-16 \d\d:05$/);
  assert.equal(catalogueLine({ generated: '', source: 'none', checked: '' }), 'Data catalogue: unknown, not checked yet');
  assert.equal(formatWhen('nonsense'), '');
});

test('the diagnostics text', () => {
  const text = diagnosticsText({
    info: INFO, versionCode: 13, userAgent: UA,
    dictionaries: [{ code: 'zh', name: 'Chinese', active: true, generated: '2026-11-06T11:54:39.439Z', extracted: '2026-10-30', bytes: 1048576 }],
    catalogue: { generated: '2026-11-06T11:54:39.439Z', source: 'saved', checked: '' },
    settings: 'handwriting pad on, history on',
    lines: ['Last open: Chinese, searchable after 5 ms'],
    lastError: '',
  }, size);
  assert.equal(text, [
    'Wiktionary Lookup Version 0.13 (13) · 0123456789ab · 2026-11-16',
    'Android 9, WebView Chrome 66.0.3359.158',
    'Dictionaries:',
    '  Chinese (zh, active): data of 2026-11-06, extract 2026-10-30, 1.0 MiB',
    'Data catalogue: 2026-11-06 (saved list), not checked yet',
    'Settings: handwriting pad on, history on',
    'Last open: Chinese, searchable after 5 ms',
    'Last error: none',
  ].join('\n'));
  assert.equal(androidVersion('Mozilla/5.0 (X11; Linux x86_64)'), '');
  const desktop = diagnosticsText({ info: {}, userAgent: 'Mozilla/5.0 (X11) Chrome/120.0.1 Safari', dictionaries: [] }, size);
  assert.match(desktop, /^Wiktionary Lookup Version \? · dev\nWebView Chrome 120\.0\.1\nDictionaries:\n {2}none installed\n/);
  assert.match(desktop, /Last error: none$/);
});

test('the problem report link: prefilled, below 2000 characters, cut with a note when needed', () => {
  const short = issueUrl('Wiktionary Lookup Version 0.13\nLast error: none', INFO);
  assert.ok(short.startsWith(`${ISSUE_URL}?title=`), short);
  assert.equal(ISSUE_URL, 'https://github.com/d33mobile/wiktionary-lookup/issues/new');
  const params = new URL(short).searchParams;
  assert.equal(params.get('title'), 'Problem in Wiktionary Lookup 0.13');
  assert.match(params.get('body'), /Diagnostics:\nWiktionary Lookup Version 0\.13\nLast error: none\n$/);
  assert.doesNotMatch(params.get('body'), /Cut to fit/);

  const long = Array.from({ length: 120 }, (_, i) => `  Language ${i} (x${i}): data of 2026-11-06, extract 2026-10-30, 12.0 MiB`).join('\n');
  const url = issueUrl(`Wiktionary Lookup Version 0.13\n${long}`, INFO);
  assert.ok(url.length < MAX_URL, url.length);
  assert.ok(url.length > MAX_URL - 200, `uses the room it has: ${url.length}`);
  const body = new URL(url).searchParams.get('body');
  assert.match(body, /^What happened.*\n\n\n\nDiagnostics:\nWiktionary Lookup Version 0\.13\n {2}Language 0 /s);
  assert.match(body, /Cut to fit the link: please paste the full text from About > Diagnostics > Copy diagnostics\.\)\n$/);
});
