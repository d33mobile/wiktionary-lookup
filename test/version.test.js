// web/version.json: the build identity stage-web.js writes from the git
// checkout it stages (commit, "-dirty", commit date, version from
// build.gradle or the environment), and "dev" outside git.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildInfo, SOURCE_URL, stage, VERSION_NAME } from '../stage-web.js';

const GRADLE = "android {\n    defaultConfig {\n        versionCode 13\n        versionName '0.13'\n    }\n}\n";

const made = [];
after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

function temp(prefix) {
  const d = mkdtempSync(join(tmpdir(), prefix));
  made.push(d);
  return d;
}

function git(root, ...args) {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.org', ...args],
    { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_COMMITTER_DATE: '2026-11-16T12:00:00+01:00', GIT_AUTHOR_DATE: '2026-11-16T12:00:00+01:00' } }).trim();
}

function tree() {
  const root = temp('version-test-');
  mkdirSync(join(root, 'android', 'app'), { recursive: true });
  mkdirSync(join(root, 'web'));
  writeFileSync(join(root, 'android', 'app', 'build.gradle'), GRADLE);
  writeFileSync(join(root, 'web', 'app.js'), '// app\n');
  return root;
}

function repo() {
  const root = tree();
  git(root, 'init', '-q');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'one');
  return root;
}

test('a clean checkout: its commit, the commit date and the version from build.gradle', () => {
  const root = repo();
  const head = git(root, 'rev-parse', 'HEAD');
  const info = buildInfo(root, {});
  assert.deepEqual(info, {
    version: '0.13', versionCode: 13, commit: head.slice(0, 12), committed: '2026-11-16T12:00:00+01:00', source: SOURCE_URL,
  });
  assert.equal(SOURCE_URL, 'https://github.com/d33mobile/wiktionary-lookup');
});

test('a change to a file the build uses marks the commit dirty; other files do not', () => {
  const root = repo();
  const head = git(root, 'rev-parse', '--short=12', 'HEAD');
  writeFileSync(join(root, 'notes.txt'), 'not part of the app\n');
  assert.equal(buildInfo(root, {}).commit, head);
  writeFileSync(join(root, 'web', 'app.js'), '// changed\n');
  assert.equal(buildInfo(root, {}).commit, `${head}-dirty`);
  git(root, 'checkout', '--', 'web/app.js');
  writeFileSync(join(root, 'web', 'new.js'), '// untracked\n');
  assert.equal(buildInfo(root, {}).commit, `${head}-dirty`, 'an untracked file under web/ counts');
});

test('VERSION_NAME and VERSION_CODE override build.gradle', () => {
  const info = buildInfo(repo(), { VERSION_NAME: '0.14', VERSION_CODE: '14' });
  assert.equal(info.version, '0.14');
  assert.equal(info.versionCode, 14);
});

test('outside git, or in a directory of some other checkout: commit "dev"', () => {
  const plain = tree();
  assert.deepEqual(buildInfo(plain, {}), { version: '0.13', versionCode: 13, commit: 'dev', committed: '', source: SOURCE_URL });
  const outer = repo();
  const inner = join(outer, 'web');
  assert.equal(buildInfo(inner, {}).commit, 'dev');
  assert.deepEqual(buildInfo(join(outer, 'missing-dir'), {}).commit, 'dev');
});

test('stage() writes version.json for the tree it stages from', () => {
  const dest = temp('version-stage-');
  stage(dest, '-');
  const written = JSON.parse(readFileSync(join(dest, 'web', VERSION_NAME), 'utf8'));
  assert.deepEqual(written, buildInfo(join(import.meta.dirname, '..')));
  assert.match(written.commit, /^([0-9a-f]{12}(-dirty)?|dev)$/);
  assert.equal(written.source, SOURCE_URL);
});
