# Wiktionary Lookup

An offline dictionary for every language of English Wiktionary, with search
as you type, Wiktionary-style entry pages, pronunciation (Wiktionary
recordings or text-to-speech), handwriting input for Chinese and Japanese,
history and favourites, and Wikipedia article titles (English, German,
Polish) with their short descriptions. It runs as a static web page and as an Android app (a WebView
around the same page), published in an F-Droid repository:
https://d33mobile.github.io/wiktionary-lookup-fdroid/

The dictionary data comes from kaikki.org's wiktextract extracts of English
Wiktionary. Prebuilt indexes for all languages are release assets of
https://github.com/d33mobile/wiktionary-lookup-data (`manifest.json` lists
them).

## Layout

```
lib/                 lookup engine (browser-safe ES modules, no dependencies)
  engine.js          Dictionary, Session (incremental prefix search), openIndex
  index-format.js    binary index container
  normalize.js       search key derivation shared by builder and engine
build-index.js       SOURCE FILE OUT: entries -> index (+ .details sidecar)
sources/             entry sources: wiktionary (any language), wiktionary-zh,
                     wiktionary-details (entry pages), wikipedia-titles, cedict-text
scripts/             kaikki-languages.js (language list, downloads), build-all.js
                     (every language + manifest.json), wikipedia-*.js, export-public.sh
lookup.js, tui.js    Node API / one-shot CLI, terminal UI
web/                 the app: index.html, app.js and modules, vendored HanziLookupJS
android/             Android app (Gradle, Java): WebView, release download proxy,
                     audio cache, text-to-speech, optional Sentry
stage-web.js         lays out web/ + engine + an index for a server or the APK
test/                node:test suites; test/web: headless Chromium and emulator tests
```

## Building

Node 22 or newer; no npm dependencies.

```sh
node scripts/kaikki-languages.js            # language list (data/languages.json)
node build-index.js wiktionary-zh kaikki.org-dictionary-Chinese.jsonl zh.idx
node lookup.js zh.idx nihao                 # one-shot lookup
node tui.js zh.idx                          # interactive
node scripts/build-all.js                   # every language, see the script header
node scripts/hanzi-pack.js graphics.txt dictionary.txt hanzi.pack   # stroke order data
```

The stroke order data (`hanzi.pack`, read by `lib/hanzi-pack.js`) is converted
from Make Me a Hanzi (https://github.com/skishore/makemeahanzi): `graphics.txt`
(Arphic Public License) and `dictionary.txt` (LGPL 3.0 or later). The data
release publishes it as `hanzi.pack.gz` (manifest key `hanzi`); the app
downloads it on request.

Web app: `node stage-web.js DEST zh.idx|- [manifest.json]` (`-`: no built-in language), then serve `DEST`
and open `/web/index.html`.

Android: `android/build-apk.sh zh.idx|- [OUT_DIR [MANIFEST]]` builds a debug
APK (Android SDK, JDK 17). Crash reporting is off unless the build gets a
`SENTRY_DSN` (Gradle property, environment or `android/local.properties`).

## Release build

The APKs in the F-Droid repository are built from this source as follows,
then signed with the maintainer's key; the label, package id (`pl.d33.wiktionary`),
versionCode and versionName come from the source (`android/app/build.gradle`,
`strings.xml`).

```sh
# The language list shipped with the app (no built-in language since 0.9),
# from the data release current at the time of the app release:
curl -L https://github.com/d33mobile/wiktionary-lookup-data/releases/download/data-2026-10-23b/manifest.json -o manifest.json
node stage-web.js android/app/src/main/assets - manifest.json
cd android && ./gradlew assembleRelease     # app/build/outputs/apk/release/app-release-unsigned.apk
```

To sign during the build, set `RELEASE_STORE_FILE`, `RELEASE_STORE_PASSWORD`,
`RELEASE_KEY_ALIAS` and `RELEASE_KEY_PASSWORD` (Gradle properties, environment
or `android/local.properties`); otherwise sign the unsigned APK with
`zipalign -p 4` and `apksigner sign`. Crash reporting stays off unless
`SENTRY_DSN` is set (the published builds have none).

## Tests

```sh
npm test                                     # engine, sources, format, old-WebView checks
python3 test/web/smoke.py --index zh.idx     # headless Chromium (Playwright)
cd android && ./gradlew testDebugUnitTest    # JVM tests of the Android code
```

## License

The lookup engine and tools (`lib/`, `sources/`, `scripts/`, `build-index.js`,
`lookup.js`, `tui.js`, `bench.js`, `stage-web.js` and their tests) are MIT
licensed (`LICENSE`). The app (`web/`, `android/`) is licensed under the GNU
General Public License, version 3 or later (`web/LICENSE`,
`android/LICENSE`), because it includes HanziLookupJS (GPL). The handwriting
stroke data (`web/vendor/hanzilookup/mmah.json`) is under the Arphic Public
License (`web/vendor/hanzilookup/LICENSE-APL`). `web/THIRD_PARTY.md` lists all
third-party components. Dictionary data: Wiktionary contributors, CC BY-SA 4.0
and GFDL.
