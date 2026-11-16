#!/usr/bin/env node
// Usage: node stage-web.js DEST INDEX|- [MANIFEST]
// Lays out the web app as it is served (from a static server root or the
// Android app's assets directory):
//   DEST/web/index.html, app.js, ...          the page
//   DEST/web/index.idx                        a copy of INDEX (the built-in language), unless INDEX is -
//   DEST/web/index.details                    its entry pages (INDEX's .details sidecar), if any
//   DEST/web/bundle.json                      {index, details: whether index.idx / index.details are there}
//   DEST/web/CHANGELOG.md                     the changelog, shown after updates
//   DEST/web/manifest.json                    a copy of MANIFEST, the language list shown
//                                             before the app reaches the data releases
//                                             (an empty list without MANIFEST)
//   DEST/web/version.json                     the build's identity (buildInfo below), shown in About
//   DEST/lib/engine.js and its imports        the engine, unbundled
// DEST is emptied of these files first; nothing else in it is touched.
import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const WEB_FILES = ['index.html', 'app.js', 'about.js', 'detail.js', 'languages.js', 'library.js', 'inflate.js', 'pronounce.js', 'style.css',
  'flags.json', 'handwriting.js', 'hanzi.js', 'THIRD_PARTY.md', 'LICENSE'];
// Copied as a whole: vendored libraries with their licenses.
export const WEB_DIRS = ['vendor'];
export const ENGINE_FILES = ['engine.js', 'index-format.js', 'bisect.js', 'fuzzy.js', 'normalize.js', 'lazy-index.js', 'hanzi-pack.js'];
export const INDEX_NAME = 'index.idx';
export const MANIFEST_NAME = 'manifest.json';
export const VERSION_NAME = 'version.json';
export const SOURCE_URL = 'https://github.com/d33mobile/wiktionary-lookup';
// What a build is made of: a change under these paths marks the commit "-dirty".
const BUILD_PATHS = ['web', 'lib', 'android', 'CHANGELOG.md', 'stage-web.js'];
const COMMIT_DIGITS = 12;

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

// The identity of the tree at `root` (this script's directory by default):
// {version, versionCode, commit, committed, source}. version and versionCode
// come from VERSION_NAME / VERSION_CODE in `env` (the release build sets
// them) or android/app/build.gradle; commit is the abbreviated HEAD with
// "-dirty" when the files a build uses differ from it, committed the commit
// date (ISO 8601, not the build time, so a rebuild of the same commit gives
// the same file). Outside a git checkout of `root`: commit "dev".
export function buildInfo(root = import.meta.dirname, env = process.env) {
  let gradle = '';
  try {
    gradle = readFileSync(join(root, 'android', 'app', 'build.gradle'), 'utf8');
  } catch (err) {
    gradle = '';
  }
  const fromGradle = (name) => {
    const m = new RegExp(`^\\s*${name}\\s+'?([^'\\s]+)'?\\s*$`, 'm').exec(gradle);
    return m ? m[1] : '';
  };
  const info = {
    version: env.VERSION_NAME || fromGradle('versionName'),
    versionCode: Number(env.VERSION_CODE || fromGradle('versionCode')) || 0,
    commit: 'dev',
    committed: '',
    source: SOURCE_URL,
  };
  try {
    // Only the checkout `root` is the top of, not one it happens to sit in.
    if (realpathSync(git(root, ['rev-parse', '--show-toplevel'])) !== realpathSync(root)) return info;
    const commit = git(root, ['rev-parse', `--short=${COMMIT_DIGITS}`, 'HEAD']);
    const dirty = git(root, ['status', '--porcelain', '--', ...BUILD_PATHS]) !== '';
    info.commit = dirty ? `${commit}-dirty` : commit;
    info.committed = git(root, ['log', '-1', '--format=%cI', 'HEAD']);
  } catch (err) {
    // Not a git checkout, or git is missing: a development build.
  }
  return info;
}

export function stage(dest, index, manifest) {
  const here = import.meta.dirname;
  rmSync(join(dest, 'web'), { recursive: true, force: true });
  rmSync(join(dest, 'lib'), { recursive: true, force: true });
  mkdirSync(join(dest, 'web'), { recursive: true });
  mkdirSync(join(dest, 'lib'), { recursive: true });
  for (const f of WEB_FILES) copyFileSync(join(here, 'web', f), join(dest, 'web', f));
  for (const d of WEB_DIRS) cpSync(join(here, 'web', d), join(dest, 'web', d), { recursive: true });
  for (const f of ENGINE_FILES) copyFileSync(join(here, 'lib', f), join(dest, 'lib', f));
  // INDEX '-' (or none): no built-in language; the app starts with the
  // language list and downloads the chosen one.
  const hasIndex = Boolean(index) && index !== '-';
  if (hasIndex) copyFileSync(index, join(dest, 'web', INDEX_NAME));
  // Its entry pages, when INDEX has a .details sidecar next to it.
  const details = hasIndex ? index.replace(/\.idx$/, '') + '.details' : '';
  const hasDetails = hasIndex && existsSync(details);
  if (hasDetails) copyFileSync(details, join(dest, 'web', 'index.details'));
  writeFileSync(join(dest, 'web', 'bundle.json'), `${JSON.stringify({ index: hasIndex, details: hasDetails })}\n`);
  copyFileSync(join(here, 'CHANGELOG.md'), join(dest, 'web', 'CHANGELOG.md'));
  if (manifest) copyFileSync(manifest, join(dest, 'web', MANIFEST_NAME));
  else writeFileSync(join(dest, 'web', MANIFEST_NAME), '{"languages":[]}\n');
  writeFileSync(join(dest, 'web', VERSION_NAME), `${JSON.stringify(buildInfo(here))}\n`);
}

if (process.argv[1] === import.meta.filename) {
  const [dest, index, manifest] = process.argv.slice(2);
  if (!dest || !index) {
    console.error('usage: stage-web.js DEST INDEX|- [MANIFEST]');
    process.exit(2);
  }
  stage(dest, index, manifest);
  console.log(`staged web app, ${index} and ${manifest ?? 'an empty language list'} into ${dest}`);
  console.log(`version.json: ${readFileSync(join(dest, 'web', VERSION_NAME), 'utf8').trim()}`);
}
