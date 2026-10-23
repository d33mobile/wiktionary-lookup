#!/usr/bin/env bash
# Usage: scripts/export-public.sh OUT_DIR [COMMIT_MESSAGE]
#
# Writes the public source tree of Wiktionary Lookup (the app, the engine,
# the Wiktionary and Wikipedia sources, their tests) from the committed HEAD
# of this repository into OUT_DIR, replacing everything there except .git.
# Files of the other dictionary format this working repository also handles
# stay out, public/ supplies the public README and package.json, and a few
# mentions are rewritten. The export fails if the tree still names that
# format. With COMMIT_MESSAGE and a git repository in OUT_DIR, the result is
# committed there (as d33mobile), ready to push.
set -euo pipefail

out=${1:?usage: export-public.sh OUT_DIR [COMMIT_MESSAGE]}
message=${2:-}
here=$(cd "$(dirname "$0")/.." && pwd)
forbidden=$(printf '%s' 'cGxlY28=' | base64 -d)

include=(
  web android lib build-index.js lookup.js tui.js bench.js stage-web.js CHANGELOG.md LICENSE .gitignore
  data/languages.json syllables.json
  scripts/kaikki-languages.js scripts/build-all.js scripts/wikipedia-sql.js scripts/wikipedia-prepare.js
  scripts/wikipedia-bench.js scripts/export-public.sh
  sources/wiktionary.js sources/wiktionary-zh.js sources/wiktionary-details.js sources/wikipedia-titles.js
  sources/cedict-text.js
  test
)
mkdir -p "$out"
find "$out" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
git -C "$here" archive HEAD "${include[@]}" | tar -x -C "$out"
cp "$here/public/README.md" "$here/public/package.json" "$out/"

# Tests of the other format and anything that loads it.
( cd "$out" && for f in test/*.js; do
    if grep -qil "$forbidden" "$f"; then
      case "$f" in
        test/index-format.test.js|test/helpers.js) ;;
        *) rm "$f" ;;
      esac
    fi
  done )

# Mentions in shared files.
sed -i "s/not a ${forbidden}-lookup index file/not a wiktionary-lookup index file/" "$out"/lib/*.js
sed -i -e "s/not a ${forbidden}-lookup index/not a wiktionary-lookup index/" \
       -e "s/'${forbidden}-lookup-'/'wiktionary-lookup-'/" "$out/test/index-format.test.js"
sed -i -e "s/${forbidden^^}_LOOKUP_INDEX/LOOKUP_INDEX/" \
       -e "s|/mnt/biglinks/${forbidden}-apk/lookup-data/cedict.idx|data/cedict.idx|" "$out/test/helpers.js"
sed -i "s/${forbidden^}'s table/The source table/" "$out/lib/pinyin-marks.js"

if found=$(grep -rIil "$forbidden" "$out" --exclude-dir=.git) || \
   found=$(find "$out" -path "$out/.git" -prune -o -iname "*${forbidden}*" -print | grep .); then
  echo "export-public.sh: still mentioned in:"; echo "$found"; exit 1
fi
echo "exported $(find "$out" -path "$out/.git" -prune -o -type f -print | wc -l) files to $out"

if [ -n "$message" ] && [ -d "$out/.git" ]; then
  git -C "$out" add -A
  git -C "$out" -c user.name=d33mobile -c user.email=d33mobile@users.noreply.github.com \
      commit -q -m "$message" && git -C "$out" log --oneline -1
fi
