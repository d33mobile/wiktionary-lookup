#!/bin/sh
# Usage: android/build-apk.sh INDEX|- [OUT_DIR [MANIFEST]]   (- : no built-in language)
# Stages the web app, the engine, INDEX (the built-in language) and MANIFEST
# (the language list shown before the app reaches the data releases) into
# app/src/main/assets, builds the debug APK (no lint) and copies it to
# OUT_DIR (default /mnt/biglinks/wiktionary). ANDROID_HOME defaults to
# /home/user/android-sdk.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
index=${1:?usage: build-apk.sh INDEX [OUT_DIR [MANIFEST]]}
out=${2:-/mnt/biglinks/wiktionary}
manifest=${3:-}
sdk=${ANDROID_HOME:-/home/user/android-sdk}

node "$here/../stage-web.js" "$here/app/src/main/assets" "$index" $manifest
# Keep other settings (e.g. SENTRY_DSN, see app/build.gradle) when updating sdk.dir.
props="$here/local.properties"
{ grep -v '^sdk.dir=' "$props" 2>/dev/null || true; printf 'sdk.dir=%s\n' "$sdk"; } > "$props.tmp"
mv "$props.tmp" "$props"
(cd "$here" && ./gradlew --no-daemon -x lint assembleDebug)
mkdir -p "$out"
cp "$here/app/build/outputs/apk/debug/app-debug.apk" "$out/wiktionary-lookup-debug.apk"
ls -l "$out/wiktionary-lookup-debug.apk"
