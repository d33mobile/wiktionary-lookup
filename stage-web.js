#!/usr/bin/env node
// Usage: node stage-web.js DEST INDEX [MANIFEST]
// Lays out the web app as it is served (from a static server root or the
// Android app's assets directory):
//   DEST/web/index.html, app.js, ...          the page
//   DEST/web/index.idx                        a copy of INDEX (the built-in language)
//   DEST/web/index.details                    its entry pages (INDEX's .details sidecar), if any
//   DEST/web/bundle.json                      {details: whether index.details is there}
//   DEST/web/CHANGELOG.md                     the changelog, shown after updates
//   DEST/web/manifest.json                    a copy of MANIFEST, the language list shown
//                                             before the app reaches the data releases
//                                             (an empty list without MANIFEST)
//   DEST/lib/engine.js and its imports        the engine, unbundled
// DEST is emptied of these files first; nothing else in it is touched.
import { copyFileSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const WEB_FILES = ['index.html', 'app.js', 'detail.js', 'languages.js', 'inflate.js', 'pronounce.js', 'style.css',
  'flags.json', 'handwriting.js', 'THIRD_PARTY.md', 'LICENSE'];
// Copied as a whole: vendored libraries with their licenses.
export const WEB_DIRS = ['vendor'];
export const ENGINE_FILES = ['engine.js', 'index-format.js', 'bisect.js', 'normalize.js'];
export const INDEX_NAME = 'index.idx';
export const MANIFEST_NAME = 'manifest.json';

export function stage(dest, index, manifest) {
  const here = import.meta.dirname;
  rmSync(join(dest, 'web'), { recursive: true, force: true });
  rmSync(join(dest, 'lib'), { recursive: true, force: true });
  mkdirSync(join(dest, 'web'), { recursive: true });
  mkdirSync(join(dest, 'lib'), { recursive: true });
  for (const f of WEB_FILES) copyFileSync(join(here, 'web', f), join(dest, 'web', f));
  for (const d of WEB_DIRS) cpSync(join(here, 'web', d), join(dest, 'web', d), { recursive: true });
  for (const f of ENGINE_FILES) copyFileSync(join(here, 'lib', f), join(dest, 'lib', f));
  copyFileSync(index, join(dest, 'web', INDEX_NAME));
  // Its entry pages, when INDEX has a .details sidecar next to it.
  const details = index.replace(/\.idx$/, '') + '.details';
  const hasDetails = existsSync(details);
  if (hasDetails) copyFileSync(details, join(dest, 'web', 'index.details'));
  writeFileSync(join(dest, 'web', 'bundle.json'), `${JSON.stringify({ details: hasDetails })}\n`);
  copyFileSync(join(here, 'CHANGELOG.md'), join(dest, 'web', 'CHANGELOG.md'));
  if (manifest) copyFileSync(manifest, join(dest, 'web', MANIFEST_NAME));
  else writeFileSync(join(dest, 'web', MANIFEST_NAME), '{"languages":[]}\n');
}

if (process.argv[1] === import.meta.filename) {
  const [dest, index, manifest] = process.argv.slice(2);
  if (!dest || !index) {
    console.error('usage: stage-web.js DEST INDEX [MANIFEST]');
    process.exit(2);
  }
  stage(dest, index, manifest);
  console.log(`staged web app, ${index} and ${manifest ?? 'an empty language list'} into ${dest}`);
}
