#!/usr/bin/env python3
"""Headless Chromium test of the web app.

Usage: python3 test/web/smoke.py [--root DIR | --index FILE] [--shots DIR]

--root serves an already staged tree (e.g. android/app/src/main/assets);
--index stages web/ + lib/ + FILE into a temporary directory first with
stage-web.js. Next to the app the server mimics the data releases on GitHub
under /releases/ (latest/download/manifest.json and download/<tag>/<code>.idx.gz)
with a German index built from fixtures/de.jsonl, sent slowly so the
download progress is visible.

Chinese: types "nihao" one key at a time, asserts 你好 is the first result,
opens its detail view, checks hanzi, pinyin and English queries and the
result group headings ("shit" lists English matches before pinyin ones). Languages: opens the picker, finds German (only in the remote
manifest, the bundled one lists Chinese alone), checks the size warning of a
large entry, downloads German, searches
"Haus", reloads the page to check German stays installed and active without
a second download, switches back to Chinese, removes German.
The language part runs twice: in plain Chromium and with the APIs Chromium
66 lacks removed (DecompressionStream, TransformStream, replaceChildren,
replaceAll, matchAll), so the download goes through web/inflate.js. Last, a
broken app.js must show "Could not start: ..." instead of "Loading index...".
Screenshots go to --shots. Exit status 0 on success.
"""
import argparse
import functools
import gzip
import hashlib
import http.server
import json
import pathlib
import shutil
import subprocess
import sys
import tempfile
import threading
import time

from playwright.sync_api import sync_playwright

REPO = pathlib.Path(__file__).resolve().parents[2]
HERE = pathlib.Path(__file__).resolve().parent
CHROMIUM = "/usr/bin/chromium"
DEFAULT_INDEX = "/mnt/biglinks/wiktionary/wiktionary-zh.idx"
LOAD_TIMEOUT_MS = 60_000
RELEASE_TAG = "data-test"
# The fixture index is a few KiB; small chunks with a pause make the
# download last long enough to observe the progress bar.
CHUNK_BYTES = 256
CHUNK_PAUSE_S = 0.05


def build_fixture(source, jsonl, out, details="sidecar"):
    subprocess.run(["node", str(HERE / "build-fixture.mjs"), str(source), str(jsonl), str(out), details],
                   check=True, stdout=subprocess.DEVNULL)


def gz_entry(path, url):
    """Gzips path next to itself and returns the manifest fields for it."""
    raw = path.read_bytes()
    gz = gzip.compress(raw, mtime=0)
    pathlib.Path(str(path) + ".gz").write_bytes(gz)
    return {"bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest(), "gzBytes": len(gz), "url": url}


def two_step_language(dest, download):
    """'zhd': the zh-details fixture as index + .details sidecar, both gzipped
    into the release download directory."""
    idx = download / "zhd.idx"
    build_fixture("wiktionary-zh", HERE / "fixtures" / "zh-details.jsonl", idx)
    base = gz_entry(idx, f"../../download/{RELEASE_TAG}/zhd.idx.gz")
    details = gz_entry(download / "zhd.details", f"../../download/{RELEASE_TAG}/zhd.details.gz")
    details["entries"] = 6
    return {"code": "zhd", "name": "Chinese test pages", "entries": 6, "script": "Hani", **base, "details": details}


def build_release(dest):
    """Writes the mimicked GitHub release tree under dest/releases."""
    download = dest / "releases" / "download" / RELEASE_TAG
    latest = dest / "releases" / "latest" / "download"
    download.mkdir(parents=True)
    latest.mkdir(parents=True)
    idx = dest / "de.idx"
    build_fixture(HERE / "fixture-source.js", HERE / "fixtures" / "de.jsonl", idx, "none")
    raw = idx.read_bytes()
    gz = gzip.compress(raw, mtime=0)
    (download / "de.idx.gz").write_bytes(gz)
    languages = [
        {"code": "zh", "name": "Chinese", "entries": 0, "bytes": 0, "sha256": None},
        {"code": "de", "name": "German", "entries": 10, "bytes": len(raw),
         "sha256": hashlib.sha256(raw).hexdigest(), "gzBytes": len(gz),
         "url": f"../../download/{RELEASE_TAG}/de.idx.gz"},
        # Listed only for its script sign (no flag): no url, never downloaded.
        {"code": "la", "name": "Latin", "entries": 1, "bytes": 1, "script": "Latn"},
        # A language whose entry pages are a separate download (sidecar).
        two_step_language(dest, download),
        # Never downloaded: checks the size warning only.
        {"code": "xl", "name": "Extra Large", "entries": 1, "bytes": 300 * 1048576, "sha256": None,
         "gzBytes": 100 * 1048576, "url": f"../../download/{RELEASE_TAG}/xl.idx.gz"},
    ]
    (latest / "manifest.json").write_text(json.dumps({"languages": languages}))
    bundled = dest / "bundled-manifest.json"
    bundled.write_text(json.dumps({"languages": languages[:1]}))
    return bundled


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, ".js": "text/javascript"}

    def __init__(self, *args, app_root, release_root, requests, **kwargs):
        self.app_root = app_root
        self.release_root = release_root
        self.requests = requests
        super().__init__(*args, directory=str(app_root), **kwargs)

    def translate_path(self, path):
        if path.startswith("/releases/"):
            return str(self.release_root) + path.split("?", 1)[0]
        return super().translate_path(path)

    def send_head(self):
        self.requests.append(self.path)
        return super().send_head()

    def copyfile(self, source, outputfile):
        if not self.path.startswith("/releases/download/"):
            return super().copyfile(source, outputfile)
        while chunk := source.read(CHUNK_BYTES):
            outputfile.write(chunk)
            outputfile.flush()
            time.sleep(CHUNK_PAUSE_S)
        return None

    def log_message(self, *args):
        pass


def serve(app_root, release_root, requests):
    handler = functools.partial(Handler, app_root=app_root, release_root=release_root, requests=requests)
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def result_rows(page):
    return page.locator("#results li[data-index]")


def first_result_text(page):
    return result_rows(page).first.inner_text()


def wait_results(page):
    page.wait_for_function("document.querySelectorAll('#results li[data-index]').length > 0")


def wait_language(page, code):
    page.wait_for_function(f"document.body.dataset.ready === 'true' && document.body.dataset.lang === '{code}'",
                           timeout=LOAD_TIMEOUT_MS)


def query(page, text, expected):
    page.fill("#q", text)
    wait_results(page)
    first = first_result_text(page)
    groups = page.locator("#results li.group").all_text_contents()
    print(f"{text} ->", first.splitlines()[0], "| groups", groups, "|", page.inner_text("#status"))
    assert first.startswith(expected), first
    return groups


def chinese(page, shots):
    page.locator("#q").press_sequentially("nihao", delay=50)
    wait_results(page)
    first = first_result_text(page)
    print("nihao ->", first.splitlines()[0], "|", page.inner_text("#status"))
    assert first.startswith("你好"), first
    page.screenshot(path=str(shots / "nihao.png"))

    result_rows(page).first.click()
    page.wait_for_selector("#detail:not([hidden])")
    senses = page.inner_text("#detail-senses")
    print("detail ->", page.inner_text("#detail-head"), page.inner_text("#detail-pinyin"), "|", senses.replace("\n", " / "))
    assert "hello" in senses, senses
    page.screenshot(path=str(shots / "nihao-detail.png"))

    page.go_back()
    page.wait_for_selector("#detail", state="hidden")
    assert result_rows(page).first.is_visible()
    assert page.input_value("#q") == "nihao"
    print("history back -> result list")
    result_rows(page).first.click()
    page.wait_for_selector("#detail:not([hidden])")
    page.click("#back")
    page.wait_for_selector("#detail", state="hidden")
    print("Back button -> result list")

    for text, expected in (("中国", "中国"), ("学习", "学习")):
        assert query(page, text, expected)[0] == "Headword", "hanzi results are headword matches"
    assert query(page, "zhongguo", "中国")[0] == "Pinyin"
    assert query(page, "/tea", "")[0] == "English"
    groups = query(page, "shit", "")
    assert groups[0] == "English", groups
    page.mouse.move(0, 0)
    page.screenshot(path=str(shots / "english.png"))


def languages(page, base, shots, requests):
    assert page.locator("#lang option:checked").inner_text().endswith(" Chinese")
    page.select_option("#lang", "__more")
    page.wait_for_selector("#picker:not([hidden])")
    page.fill("#lang-filter", "germ")
    german = page.locator('#lang-list li[data-code="de"]')
    german.wait_for(timeout=LOAD_TIMEOUT_MS)
    print("picker ->", german.inner_text().replace("\n", " | "), "|", page.inner_text("#picker-status"))
    # Sizes below 1 MiB in KiB (the fixture index is a few KiB).
    assert "KiB" in german.inner_text() and "0.0 MiB" not in german.inner_text(), german.inner_text()
    page.screenshot(path=str(shots / "picker.png"))

    page.fill("#lang-filter", "extra")
    large = page.locator('#lang-list li[data-code="xl"]')
    large.get_by_role("button", name="Download").click()
    warning = large.locator(".lang-warning").inner_text()
    print("size warning ->", warning)
    assert "300.0 MiB" in warning and large.get_by_role("button", name="Download anyway").is_visible()
    page.screenshot(path=str(shots / "size-warning.png"))
    page.fill("#lang-filter", "germ")

    german.get_by_role("button", name="Download").click()
    bar = german.locator("progress")
    bar.wait_for()
    page.wait_for_function("(() => { const b = document.querySelector('#lang-list li[data-code=de] progress');"
                           " return b && b.value > 0 && b.value < b.max; })()")
    print(f"progress -> {bar.evaluate('b => `${b.value}/${b.max}`')}")
    page.screenshot(path=str(shots / "downloading.png"))
    wait_language(page, "de")
    assert page.locator("#picker").is_hidden()
    assert page.locator("#lang option:checked").inner_text() == "\U0001F1E9\U0001F1EA German"
    print("installed ->", page.inner_text("#status"))
    query(page, "Haus", "Haus")
    page.screenshot(path=str(shots / "haus.png"))

    downloads = sum(r.endswith(".idx.gz") for r in requests)
    page.goto(base)
    wait_language(page, "de")
    query(page, "Haus", "Haus")
    assert sum(r.endswith(".idx.gz") for r in requests) == downloads, "reload must not download again"
    print("reload -> German still active, no second download")

    page.select_option("#lang", "zh")
    wait_language(page, "zh")
    query(page, "nihao", "你好")
    print("switch -> Chinese")

    page.select_option("#lang", "__more")
    german = page.locator('#lang-list li[data-code="de"]')
    german.get_by_role("button", name="Remove").click()
    german.get_by_role("button", name="Download").wait_for()
    options = page.locator("#lang option").all_inner_texts()
    assert [o.split(" ", 1)[-1] for o in options] == ["Chinese", "languages..."] or options[-1] == "More languages...", options
    assert len(options) == 2 and options[0].endswith(" Chinese"), options
    print("remove -> German removed, languages:", options[:-1])


# Removes what Chromium 66 (stock Android 9 WebView) lacks, so the download
# goes through the inflate.js fallback and the app through its own helpers.
LEGACY_WEBVIEW = """
delete window.DecompressionStream;
delete window.TransformStream;
delete Element.prototype.replaceChildren;
delete String.prototype.replaceAll;
delete String.prototype.matchAll;
"""


# Stands in for the Android app's JavaScript interface: records speak() calls
# and answers with window.__speakStatus.
FAKE_NATIVE = """
window.__spoken = [];
window.__prefetched = [];
window.__cached = [];
window.WiktionaryNative = {
  speak(text, code) { window.__spoken.push([text, code]); return window.__speakStatus || 'ok'; },
  networkProblem() { return ''; },
  networkMetered() { return Boolean(window.__metered); },
  cachedAudio(json) { return JSON.stringify(JSON.parse(json).filter((n) => window.__cached.indexOf(n) >= 0)); },
  prefetchAudio(json) {
    for (const n of JSON.parse(json)) {
      window.__prefetched.push(n);
      window.__cached.push(n);
      setTimeout(() => window.onAudioCached(n), 0);
    }
  },
  openTtsSettings() { window.__ttsOpened = true; },
  breadcrumb() {},
  reportError() {},
};
"""


def set_mode(page, mode):
    page.evaluate(f"(() => {{ const s = document.getElementById('pron-mode'); s.value = '{mode}';"
                  " s.dispatchEvent(new Event('change')); })()")


def speech(browser, base, shots):
    """Pronunciation buttons: the speaker (a real Wiktionary recording) only on
    rows with audio, text-to-speech (its own icon) in the detail view; speech
    goes to the app with the headword and the index language, a missing
    voice shows the settings hint."""
    context = new_context(browser)
    context.add_init_script(FAKE_NATIVE)
    page = context.new_page()
    page.goto(base)
    wait_language(page, "zh")
    page.evaluate("""window.__played = []; window.Audio = function (src) {
        window.__played.push(src); const t = new EventTarget(); t.src = src; t.pause = () => {};
        t.play = () => { setTimeout(() => t.dispatchEvent(new Event('playing')), 0); return Promise.resolve(); };
        return t; };""")

    # 你好 has a recording, 中国 has none: speaker only on 你好's row.
    query(page, "nihao", "你好")
    assert result_rows(page).first.locator("button.speak-audio").count() == 1
    query(page, "zhongguo", "中国")
    assert result_rows(page).first.locator("button.speak").count() == 0, "no icon without a recording"
    print("rows: speaker on 你好 (recording), none on 中国 (no recording)")
    result_rows(page).first.click()
    page.wait_for_selector("#detail:not([hidden])")
    assert page.locator("#detail-speak").count() == 0 and page.locator("#detail-tts").is_visible()
    print("detail of 中国: text-to-speech button only:", page.inner_text("#detail-speak-row"))
    page.click("#detail-tts")
    page.wait_for_function("document.body.dataset.spoke === 'speech:ok'")
    page.click("#back")
    page.wait_for_selector("#detail", state="hidden")

    query(page, "nihao", "你好")
    page.evaluate("document.body.dataset.spoke = ''")
    result_rows(page).first.locator("button.speak-audio").click()
    page.wait_for_function("document.body.dataset.spoke === 'audio:ok'")
    played = [p for p in page.evaluate("window.__played") if p]
    print("row speaker ->", played, "|", page.inner_text("#status"))
    assert played == ["https://commons.wikimedia.org/wiki/Special:FilePath/Zh%20n%C7%90%20h%C7%8Eo.ogg"], played
    assert page.locator("#detail").is_hidden(), "the speaker button must not open the detail view"

    result_rows(page).first.click()
    page.wait_for_selector("#detail:not([hidden])")
    row = page.inner_text("#detail-speak-row").replace("\n", " ")
    assert page.locator("#detail-speak").is_visible() and page.locator("#detail-tts").is_visible(), row
    print("detail of 你好:", row)
    page.screenshot(path=str(shots / "audio-detail.png"))
    page.evaluate("window.__spoken = []; document.body.dataset.spoke = ''")
    page.click("#detail-tts")
    page.wait_for_function("document.body.dataset.spoke === 'speech:ok'")
    spoken = page.evaluate("window.__spoken")
    print("detail text-to-speech ->", spoken)
    assert spoken == [["你好", "zh"]], spoken

    page.evaluate("window.__speakStatus = 'no-voice'")
    page.click("#detail-tts")
    page.wait_for_selector("#speech-hint:not([hidden])")
    hint = page.inner_text("#speech-hint")
    print("no voice ->", hint.replace("\n", " "))
    assert "No text-to-speech voice for Chinese" in hint, hint
    page.screenshot(path=str(shots / "speech-hint.png"))
    page.click("#speech-settings")
    assert page.evaluate("window.__ttsOpened") is True
    print("speech settings button -> openTtsSettings()")
    page.click("#back")
    page.wait_for_selector("#detail", state="hidden")

    # "Always text-to-speech": every row gets the text-to-speech button.
    set_mode(page, "speech")
    query(page, "zhongguo", "中国")
    assert result_rows(page).first.locator("button.speak-tts").count() == 1
    print("setting 'Always text-to-speech' -> text-to-speech button on every row")
    set_mode(page, "auto")
    context.close()


def prefetch(browser, base, shots):
    """Recordings of visible results are prefetched (Wi-Fi only by default,
    never on a metered network then, never when off) and marked as cached."""
    context = new_context(browser)
    context.add_init_script(FAKE_NATIVE)
    page = context.new_page()
    page.goto(base)
    wait_language(page, "zh")
    assert page.locator("#prefetch-setting").count() == 1
    page.evaluate("window.__metered = true")
    query(page, "xuexi", "学习")
    page.wait_for_timeout(800)
    assert page.evaluate("window.__prefetched") == [], "Wi-Fi only: nothing on a metered network"
    page.evaluate("window.__metered = false")
    query(page, "nihao", "你好")
    page.wait_for_function("window.__prefetched.indexOf('Zh nǐ hǎo.ogg') >= 0")
    page.wait_for_selector("#results li[data-index] button.speak-audio.cached")
    print("prefetch on Wi-Fi ->", page.evaluate("window.__prefetched"), "| cached mark shown")
    page.evaluate("(() => { const s = document.getElementById('prefetch-mode'); s.value = 'off'; s.dispatchEvent(new Event('change')); })()")
    before = len(page.evaluate("window.__prefetched"))
    query(page, "shuijiao", "睡觉")
    page.wait_for_timeout(800)
    assert len(page.evaluate("window.__prefetched")) == before, "off: no prefetch"
    print("prefetch off -> nothing fetched for shuijiao")
    page.screenshot(path=str(shots / "prefetch-cached.png"))
    context.close()


def details(browser, base, shots, legacy=False):
    """Wiktionary-style page from the index's details (test/web/fixtures/
    zh-details.jsonl: 你好, 好, 好久, 您好, 不见): tap 好 inside 好久 in
    你好's example, the "In this text" chip, Back through the stack. With
    legacy=True the details blocks go through web/inflate.js."""
    context = new_context(browser)
    if legacy:
        context.add_init_script(LEGACY_WEBVIEW)
    page = context.new_page()
    page.goto(base + "&index=zh-details.idx")
    wait_language(page, "zh")
    query(page, "nihao", "你好")
    result_rows(page).first.click()
    page.wait_for_function("document.body.dataset.details === 'loaded'")
    print("detail ->", page.inner_text("#detail-pinyin").replace("\n", " | ")[:160], "|",
          page.locator(".detail-h, .detail-h4").all_text_contents())
    example = page.locator(".ex-text").first.inner_text()
    assert example == "你好，好久不见。", example
    assert page.locator(".ex-roman").first.inner_text() == "Nǐ hǎo, hǎojiǔbùjiàn."
    assert page.locator(".ex-trans").first.inner_text() == "Hi, long time no see."
    assert "Bopomofo" in page.inner_text("#detail-pinyin")
    if not legacy:
        page.screenshot(path=str(shots / "detail-nihao.png"), full_page=True)

    page.locator(".related-synonyms button.chip", has_text="您好").first.click()
    page.wait_for_function("document.body.dataset.detail === '您好' && document.body.dataset.details === 'loaded'")
    print("synonym chip 您好 ->", page.locator("#detail-senses li.sense").first.inner_text().splitlines()[0])
    page.go_back()
    page.wait_for_function("document.body.dataset.detail === '你好' && document.body.dataset.details === 'loaded'")

    page.locator('.ex-text .ch[data-i="3"]').click()  # 好 of 好久
    page.wait_for_function("document.body.dataset.detail === '好' && document.body.dataset.details === 'loaded'")
    extras = page.locator(".lookup-extras").inner_text().replace("\n", " ")
    print("tap 好 in 好久 ->", page.inner_text("#detail-head"), "|", extras)
    assert "In this text: 好久" in extras and "hao4" in extras, extras
    if not legacy:
        page.screenshot(path=str(shots / "detail-hao.png"), full_page=True)
    page.locator(".lookup-extras button.word-chip").click()
    page.wait_for_function("document.body.dataset.detail === '好久'")
    print("chip 好久 ->", page.locator("#detail-senses li.sense").first.inner_text().splitlines()[0])
    for expected in ("好", "你好"):
        page.go_back()
        page.wait_for_function(f"document.body.dataset.detail === '{expected}'")
    page.go_back()
    page.wait_for_selector("#detail", state="hidden")
    assert result_rows(page).first.is_visible()
    print("Back x3 -> 好 -> 你好 -> result list")
    context.close()


def draw(page, strokes):
    """Draws strokes ([(x, y), ...] in the 280-unit canvas space) with the mouse."""
    box = page.locator("#pad-canvas").bounding_box()
    scale = box["width"] / 280
    for stroke in strokes:
        x0, y0 = stroke[0]
        page.mouse.move(box["x"] + x0 * scale, box["y"] + y0 * scale)
        page.mouse.down()
        for x, y in stroke[1:]:
            page.mouse.move(box["x"] + x * scale, box["y"] + y * scale, steps=12)
        page.mouse.up()


def candidates(page, count):
    page.wait_for_function(f"document.querySelectorAll('#pad-candidates .pad-candidate').length > 0 && "
                           f"/^\\d+ candidates/.test(document.getElementById('pad-status').textContent) && "
                           f"window.__strokes === {count}")
    return page.locator("#pad-candidates .pad-candidate").all_text_contents()


def handwriting(browser, base, shots):
    """Pen button (zh), recognizer loaded on first open, 一 and 十 drawn with
    synthetic strokes are among the candidates, a candidate goes into the
    query, undo and clear work."""
    context = new_context(browser)
    page = context.new_page()
    page.goto(base)
    wait_language(page, "zh")
    assert page.locator("#pen").is_visible()
    page.click("#pen")
    page.wait_for_selector("body[data-pad=ready]", timeout=LOAD_TIMEOUT_MS)
    print("pad ->", page.inner_text("#pad-status"))
    # Count strokes as the pad sees them, so each wait is for this drawing's result.
    page.evaluate("""window.__strokes = 0;
        document.getElementById('pad-canvas').addEventListener('pointerup', () => { window.__strokes++; });""")
    draw(page, [[(40, 140), (240, 140)]])
    one = candidates(page, 1)
    print("一 ->", one, "|", page.inner_text("#pad-status"))
    assert "一" in one, one
    page.click("#pad-clear")
    page.evaluate("window.__strokes = 0")
    draw(page, [[(40, 130), (240, 130)], [(140, 30), (140, 250)]])
    ten = candidates(page, 2)
    print("十 ->", ten, "|", page.inner_text("#pad-status"))
    assert "十" in ten, ten
    page.screenshot(path=str(shots / "handwriting.png"))
    page.locator("#pad-candidates .pad-candidate", has_text="十").first.click()
    page.wait_for_function("document.getElementById('q').value === '十'")
    wait_results(page)
    print("pick 十 -> query", page.input_value("#q"), "|", first_result_text(page).splitlines()[0])
    assert page.locator("#pad-candidates .pad-candidate").count() == 0, "picking clears the pad"
    page.evaluate("window.__strokes = 0")
    draw(page, [[(40, 130), (240, 130)], [(140, 30), (140, 250)]])
    candidates(page, 2)
    page.click("#pad-undo")
    page.wait_for_function("/^\\d+ candidates/.test(document.getElementById('pad-status').textContent)")
    print("undo ->", page.locator("#pad-candidates .pad-candidate").all_text_contents()[:4])
    context.close()


def two_step(browser, base, shots):
    """Dictionary and entry pages download separately: the detail view
    without pages offers them, they attach without a reload, and they can
    be removed on their own."""
    context = new_context(browser)
    page = context.new_page()
    page.goto(base)
    wait_language(page, "zh")
    page.select_option("#lang", "__more")
    page.fill("#lang-filter", "test pages")
    row = page.locator('#lang-list li[data-code="zhd"]')
    print("picker ->", row.inner_text().replace("\n", " | "))
    row.get_by_role("button", name="Download dictionary").click()
    wait_language(page, "zhd")
    query(page, "nihao", "你好")
    result_rows(page).first.click()
    page.wait_for_function("document.body.dataset.details === 'none'")
    offer = page.locator("#detail-get-pages")
    print("detail without pages ->", offer.inner_text())
    assert offer.is_visible()
    page.screenshot(path=str(shots / "detail-offer.png"))
    offer.click()
    page.wait_for_function("document.body.dataset.detailsInstalled === 'zhd' && document.body.dataset.details === 'loaded'")
    print("after download ->", page.locator(".ex-text").first.inner_text(), "|", page.locator(".detail-h").all_text_contents())
    page.click("#back")
    page.wait_for_selector("#detail", state="hidden")
    page.select_option("#lang", "__more")
    page.fill("#lang-filter", "test pages")
    row.get_by_role("button", name="Remove entry pages").click()
    row.get_by_role("button", name="Download entry pages").wait_for()
    print("remove entry pages ->", row.inner_text().replace("\n", " | "))
    page.reload()
    wait_language(page, "zhd")
    query(page, "nihao", "你好")
    result_rows(page).first.click()
    page.wait_for_function("document.body.dataset.details === 'none'")
    assert page.locator("#detail-get-pages").is_visible()
    print("reload -> plain definition, offer shown again")
    context.close()


# A profile that already chose its language and saw this version's notes.
RETURNING = """
localStorage.setItem('wiktionary-lookup.welcomed', '1');
if (!localStorage.getItem('wiktionary-lookup.seenVersion')) localStorage.setItem('wiktionary-lookup.seenVersion', '999');
"""


def new_context(browser, returning=True, **kwargs):
    context = browser.new_context(viewport={"width": 412, "height": 860}, device_scale_factor=2, **kwargs)
    if returning:
        context.add_init_script(RETURNING)
    return context


def first_start(browser, base, shots):
    """A fresh profile shows the language list first (Chinese built in, flags
    and script signs); choosing Chinese shows the search screen; an update
    from an older version shows "What's new" once."""
    context = new_context(browser, returning=False)
    page = context.new_page()
    page.goto(base)
    page.wait_for_selector("body[data-screen=welcome]", timeout=LOAD_TIMEOUT_MS)
    assert page.locator("#picker").is_visible() and page.locator("#changelog").is_hidden()
    zh = page.locator('#lang-list li[data-code="zh"]')
    la = page.locator('#lang-list li[data-code="la"]')
    la.wait_for()
    zh_mark = zh.locator(".lang-mark").inner_text()
    la_mark = la.locator(".lang-mark").inner_text()
    print("welcome ->", page.inner_text("#picker-title"), "| zh mark", repr(zh_mark), "| la mark", repr(la_mark))
    assert zh_mark == "\U0001F1E8\U0001F1F3", zh_mark
    assert la_mark == "Aa" and "sign" in la.locator(".lang-mark").get_attribute("class"), la_mark
    page.screenshot(path=str(shots / "welcome.png"))
    page.click("#about")
    page.wait_for_selector("#changelog:not([hidden])")
    source = page.get_attribute('#changelog-body a[href*="github.com/d33mobile/wiktionary-lookup"]', "href")
    print("About ->", page.inner_text("#changelog-title"), "| source link", source)
    assert source == "https://github.com/d33mobile/wiktionary-lookup", source
    page.click("#changelog-close")
    zh.get_by_role("button", name="Use").click()
    page.wait_for_selector("body[data-screen=search]")
    assert page.locator("#picker").is_hidden()
    header = page.locator("#lang option:checked").inner_text()
    print("chose Chinese -> search screen, header", repr(header))
    assert header.startswith("\U0001F1E8\U0001F1F3"), header
    page.reload()
    wait_language(page, "zh")
    page.wait_for_selector("body[data-screen=search]")
    print("reload -> no language list, no notes:", page.locator("#changelog").is_hidden())
    assert page.locator("#changelog").is_hidden()
    context.close()

    context = new_context(browser, returning=False)
    context.add_init_script("""if (!sessionStorage.getItem('seeded')) {
        sessionStorage.setItem('seeded', '1');
        localStorage.setItem('wiktionary-lookup.welcomed', '1');
        localStorage.setItem('wiktionary-lookup.seenVersion', '3');
    }""")
    page = context.new_page()
    page.goto(base)
    page.wait_for_selector("#changelog:not([hidden])", timeout=LOAD_TIMEOUT_MS)
    versions = page.locator("#changelog h3").all_text_contents()
    print("updated from 0.3 -> What's new:", versions)
    assert versions[-1] == "Version 0.4" and "Version 0.3" not in versions and len(versions) >= 2, versions
    page.screenshot(path=str(shots / "changelog.png"))
    page.click("#changelog-close")
    page.reload()
    wait_language(page, "zh")
    page.wait_for_timeout(1000)
    assert page.locator("#changelog").is_hidden(), "the notes appear once"
    print("after OK and reload -> no notes")
    context.close()


def broken_start(browser, base, shots):
    """A script error before the index opens must replace the loading message."""
    context = browser.new_context(viewport={"width": 412, "height": 860})
    context.route("**/web/app.js", lambda route: route.fulfill(
        status=200, content_type="text/javascript", body="export const broken = ;"))
    page = context.new_page()
    page.goto(base)
    page.wait_for_selector("body[data-ready=error]", timeout=LOAD_TIMEOUT_MS)
    status = page.inner_text("#status")
    print("broken app.js ->", status)
    assert status.startswith("Could not start:"), status
    page.screenshot(path=str(shots / "broken-start.png"))
    context.close()


def run(root, shots):
    shots.mkdir(parents=True, exist_ok=True)
    requests = []
    with tempfile.TemporaryDirectory(prefix="wiktionary-release-") as release_tmp:
        release_root = pathlib.Path(release_tmp)
        bundled = build_release(release_root)
        shutil.copyfile(bundled, root / "web" / "manifest.json")
        build_fixture("wiktionary-zh", HERE / "fixtures" / "zh-details.jsonl", root / "web" / "zh-details.idx")
        server = serve(root, release_root, requests)
        base = f"http://127.0.0.1:{server.server_address[1]}/web/index.html?data=/releases/"
        errors = []
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=CHROMIUM, args=["--no-sandbox"])
            for mode in ("modern", "legacy"):
                context = new_context(browser)
                if mode == "legacy":
                    context.add_init_script(LEGACY_WEBVIEW)
                page = context.new_page()
                page.on("pageerror", lambda e: errors.append(str(e)))
                page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
                page.goto(base)
                wait_language(page, "zh")
                print(f"[{mode}] load:", page.inner_text("#status"))
                mode_shots = shots / mode
                mode_shots.mkdir(exist_ok=True)
                if mode == "modern":
                    chinese(page, mode_shots)
                else:
                    query(page, "nihao", "你好")
                languages(page, base, mode_shots, requests)
                context.close()
            speech(browser, base, shots)
            prefetch(browser, base, shots)
            details(browser, base, shots)
            details(browser, base, shots, legacy=True)
            handwriting(browser, base, shots)
            two_step(browser, base, shots)
            first_start(browser, base, shots)
            broken_start(browser, base, shots)
            browser.close()
        server.shutdown()
    assert not errors, errors
    print("OK, screenshots in", shots)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", type=pathlib.Path)
    ap.add_argument("--index", default=DEFAULT_INDEX)
    ap.add_argument("--shots", type=pathlib.Path, default=pathlib.Path(tempfile.gettempdir()) / "wiktionary-web-shots")
    args = ap.parse_args()
    if args.root:
        run(args.root, args.shots)
        return
    with tempfile.TemporaryDirectory(prefix="wiktionary-web-") as tmp:
        subprocess.run(["node", str(REPO / "stage-web.js"), tmp, args.index], check=True)
        run(pathlib.Path(tmp), args.shots)


if __name__ == "__main__":
    sys.exit(main())
