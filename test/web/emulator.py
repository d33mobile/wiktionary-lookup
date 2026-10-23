#!/usr/bin/env python3
"""Drives the debug APK on an Android emulator over the DevTools protocol.

Usage: python3 test/web/emulator.py --serial emulator-5560 --apk APK --shots DIR
       [--package pl.d33.wiktionary.debug] [--download smj --query guolle --expect fish]

Installs the APK, starts it, forwards the WebView's DevTools socket (debug
builds enable it) and checks, in the real system WebView: a fresh install
starts with the language list and Chinese downloads from it; "shit" lists English matches first; the picker lists
the release manifest; downloading --download through the app's release
proxy works and --query finds --expect; switching back to Chinese works.
With --sentry-log (an APK built with a DSN pointing at a fake Sentry server
on the host, 10.0.2.2) it also throws an error in the page and waits for
the envelope carrying it. Screenshots come from `adb exec-out screencap`, so they show what the
device renders. Needs network access for the download.
"""
import argparse
import json
import os
import pathlib
import re
import subprocess
import sys
import time
import urllib.request

import websocket

ADB = os.environ.get("ADB", "/mnt/HC_Volume_103952790/android/sdk/platform-tools/adb")
DEVTOOLS_PORT = 9333
START_TIMEOUT_S = 600
DOWNLOAD_TIMEOUT_S = 900


class Device:
    def __init__(self, serial):
        self.serial = serial

    def adb(self, *args, check=True, **kwargs):
        return subprocess.run([ADB, "-s", self.serial, *args], check=check, capture_output=True, **kwargs).stdout

    def screenshot(self, path):
        # Without KVM the system UI often shows "isn't responding" dialogs;
        # answer "Wait" so the screenshot shows the app.
        for _ in range(3):
            self.adb("shell", "uiautomator", "dump", "/sdcard/ui.xml", check=False)
            ui = self.adb("shell", "cat", "/sdcard/ui.xml", check=False, text=True)
            wait = re.search(r'text="Wait"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"', ui)
            if "isn't responding" not in ui or not wait:
                break
            x1, y1, x2, y2 = map(int, wait.groups())
            self.adb("shell", "input", "tap", str((x1 + x2) // 2), str((y1 + y2) // 2))
            time.sleep(3)
        path.write_bytes(self.adb("exec-out", "screencap", "-p"))
        print("screenshot", path)


class Page:
    def __init__(self, ws_url):
        self.ws = websocket.create_connection(ws_url, timeout=120, suppress_origin=True)
        self.next_id = 0

    def call(self, method, **params):
        self.next_id += 1
        self.ws.send(json.dumps({"id": self.next_id, "method": method, "params": params}))
        while True:
            msg = json.loads(self.ws.recv())
            if msg.get("id") == self.next_id:
                if "error" in msg:
                    raise RuntimeError(msg["error"])
                return msg["result"]

    def eval(self, expr):
        result = self.call("Runtime.evaluate", expression=expr, returnByValue=True, awaitPromise=True)
        if "exceptionDetails" in result:
            raise RuntimeError(result["exceptionDetails"])
        return result["result"].get("value")

    def tap(self, selector):
        """A real (trusted) tap through DevTools input events: media playback
        needs a user gesture, which element.click() from script is not."""
        box = self.eval(f"(() => {{ const e = document.querySelector({json.dumps(selector)});"
                        " e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect();"
                        " const v = window.visualViewport || { offsetLeft: 0, offsetTop: 0 };"
                        " return [r.left + r.width / 2 - v.offsetLeft, r.top + r.height / 2 - v.offsetTop]; })()")
        for kind in ("mousePressed", "mouseReleased"):
            self.call("Input.dispatchMouseEvent", type=kind, x=box[0], y=box[1], button="left", clickCount=1)

    def wait(self, expr, timeout_s, what):
        t0 = time.monotonic()
        while time.monotonic() - t0 < timeout_s:
            if self.eval(expr):
                return time.monotonic() - t0
            time.sleep(2)
        raise TimeoutError(f"{what}: {self.eval('document.getElementById(\"status\").textContent')}")


def wait_network(dev, timeout_s=120):
    """After Wi-Fi or mobile data were switched back on: waits until the
    emulator reaches the internet again (a test right after a toggle otherwise
    starts downloads on a half-restored network that stall)."""
    t0 = time.monotonic()
    while time.monotonic() - t0 < timeout_s:
        out = dev.adb("shell", "ping -c 1 -W 3 8.8.8.8 >/dev/null 2>&1 && echo up", check=False, text=True)
        if "up" in out:
            return time.monotonic() - t0
        time.sleep(2)
    raise TimeoutError("network not back")


def connect(dev, package, restart=True):
    if restart:
        dev.adb("shell", "am", "force-stop", package)
        # The debug build adds ".debug" to the package; the activity keeps its class name.
        dev.adb("shell", "am", "start", "-n", f"{package}/pl.d33.wiktionary.MainActivity")
    t0 = time.monotonic()
    restarted = t0
    while True:
        pid = dev.adb("shell", "pidof", package, check=False, text=True).strip()
        sockets = dev.adb("shell", "cat", "/proc/net/unix", text=True)
        if pid and f"webview_devtools_remote_{pid}" in sockets:
            break
        if time.monotonic() - t0 > START_TIMEOUT_S:
            raise TimeoutError(f"no DevTools socket (pid {pid!r})")
        # A start right after a force-stop is sometimes dropped: start again.
        if restart and not pid and time.monotonic() - restarted > 20:
            print("connect: no process after 20 s, starting the activity again")
            dev.adb("shell", "am", "start", "-n", f"{package}/pl.d33.wiktionary.MainActivity")
            restarted = time.monotonic()
        time.sleep(3)
    dev.adb("forward", f"tcp:{DEVTOOLS_PORT}", f"localabstract:webview_devtools_remote_{pid}")
    while True:
        targets = json.load(urllib.request.urlopen(f"http://127.0.0.1:{DEVTOOLS_PORT}/json", timeout=60))
        # The app's own page (the Wiktionary panel is a second WebView).
        pages = [t for t in targets if t.get("type") == "page" and "webSocketDebuggerUrl" in t
                 and t.get("url", "").startswith("https://appassets.androidplatform.net/")]
        if pages:
            return Page(pages[0]["webSocketDebuggerUrl"])
        time.sleep(3)


def past_welcome(page):
    """A fresh install starts with the language list: take the built-in Chinese."""
    # The list is redrawn when the catalogue refresh arrives; wait for it, retry the tap.
    for _ in range(3):
        if page.eval("document.body.dataset.screen") != "welcome":
            return
        page.wait("!/checking for updates/.test(document.getElementById('picker-status').textContent)", 60, "catalogue")
        # "Use" with a built-in Chinese, "Download dictionary" without one.
        # The list may be redrawn between finding the button and tapping it.
        page.wait("!!document.querySelector('#lang-list li[data-code=\"zh\"] .lang-actions button')", 60, "Chinese row")
        try:
            page.tap('#lang-list li[data-code="zh"] .lang-actions button')
        except RuntimeError as err:
            print("past_welcome: tap missed a redrawn list, again:", str(err)[:80])
        time.sleep(1)
    try:
        page.wait("document.body.dataset.screen === 'search' && document.body.dataset.lang === 'zh'"
                  " && document.body.dataset.ready === 'true'", 600, "Chinese")
    except TimeoutError:
        print("past_welcome: picker status:", page.eval("document.getElementById('picker-status').textContent"),
              "| transfers:", page.eval("document.getElementById('transfers').innerText"),
              "| zh row:", page.eval("(document.querySelector('#lang-list li[data-code=\"zh\"]') || {}).innerText"))
        raise


def open_entry_pages(page, word):
    """Waits for the entry page of `word`; when the language's entry pages are
    not installed yet (a separate download), takes them from its offer."""
    page.wait(f"document.body.dataset.detail === {json.dumps(word)} && document.body.dataset.details !== 'loading'", 60, "entry page")
    if page.eval("document.body.dataset.details") == "none" and page.eval("!!document.getElementById('detail-get-pages')"):
        page.tap("#detail-get-pages")
    page.wait(f"document.body.dataset.detail === {json.dumps(word)} && document.body.dataset.details === 'loaded'", 600, "entry pages")


def set_query(page, text):
    return page.eval(f"""(() => {{
        const q = document.getElementById('q');
        q.blur();
        q.value = {json.dumps(text)};
        const t0 = performance.now();
        q.dispatchEvent(new Event('input'));
        return new Promise((resolve) => {{
          // A lazily opened language searches asynchronously: wait for this query's results.
          const done = () => {{
            if (document.body.dataset.searched !== q.value && performance.now() - t0 < 30000) return setTimeout(done, 20);
            const ms = performance.now() - t0;
            const groups = Array.from(document.querySelectorAll('#results li.group'), (g) => g.textContent);
        const rows = Array.from(document.querySelectorAll('#results li[data-index]'), (r) => r.innerText.replace(/\\n/g, ' | '));
            resolve({{ ms, groups, first: rows.slice(0, 3), status: document.getElementById('status').textContent }});
          }};
          done();
        }});
    }})()""")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--serial", required=True)
    ap.add_argument("--apk", required=True)
    ap.add_argument("--package", default="pl.d33.wiktionary.debug")
    ap.add_argument("--shots", type=pathlib.Path, required=True)
    ap.add_argument("--download", default="smj")
    ap.add_argument("--query", default="guolle")
    ap.add_argument("--expect", default="fish")
    ap.add_argument("--sentry-log", type=pathlib.Path,
                    help="file a fake Sentry server on the host writes envelopes to; checks an injected JS error arrives")
    args = ap.parse_args()
    args.shots.mkdir(parents=True, exist_ok=True)
    dev = Device(args.serial)
    # A fresh install, so no language is left over from an earlier run.
    dev.adb("uninstall", args.package, check=False)
    print("install:", dev.adb("install", args.apk, text=True).strip())
    page = connect(dev, args.package)
    print("user agent:", page.eval("navigator.userAgent"))
    # A fresh install has no language: the first screen is the language list.
    took = page.wait("!!document.body && !!document.body.dataset.screen", START_TIMEOUT_S, "start")
    print(f"start ({took:.0f} s):", page.eval("document.body.dataset.screen"), "|",
          page.eval("document.getElementById('status').textContent"))
    assert page.eval("document.body.dataset.screen") == "welcome"
    past_welcome(page)
    assert page.eval("document.body.dataset.ready") == "true"
    dev.screenshot(args.shots / "01-start.png")

    r = set_query(page, "what")
    print("what ->", r)
    assert r["first"][0].startswith("什么"), r
    r = set_query(page, "shit")
    print("shit ->", r)
    assert r["groups"] and r["groups"][0] == "English", r
    dev.screenshot(args.shots / "02-shit.png")

    if args.sentry_log:
        # An inline script element runs with the page's origin, so its error
        # keeps its message (code evaluated over DevTools reports "Script error.").
        stamp = int(time.time())
        thrown = f"injected test error {stamp}"
        logged = f"injected console error {stamp}"
        page.eval("(() => { const s = document.createElement('script'); "
                  f"s.textContent = {json.dumps(f'throw new Error({json.dumps(thrown)})')}; document.body.appendChild(s); "
                  f"console.error({json.dumps(logged)}); }})()")
        for marker in (thrown, logged):
            t0 = time.monotonic()
            while marker.encode() not in (args.sentry_log.read_bytes() if args.sentry_log.exists() else b""):
                if time.monotonic() - t0 > 180:
                    raise TimeoutError(f"no Sentry envelope with {marker!r}")
                time.sleep(2)
            print(f"sentry: envelope with {marker!r} arrived after {time.monotonic() - t0:.0f} s")

    page.eval("(() => { document.getElementById('gear').click(); document.getElementById('opt-more').click(); })()")
    page.wait("/languages available|could not check/.test(document.getElementById('picker-status').textContent)", 120, "manifest refresh")
    print("picker:", page.eval("document.getElementById('picker-status').textContent"),
          "| rows:", page.eval("document.querySelectorAll('#lang-list li[data-code]').length"))
    dev.screenshot(args.shots / "03-picker.png")

    code = args.download
    page.eval(f"(() => {{ const f = document.getElementById('lang-filter'); f.value = {json.dumps(code)}; f.dispatchEvent(new Event('input')); }})()")
    print("row:", page.eval(f"document.querySelector('#lang-list li[data-code=\"{code}\"]').innerText.replace(/\\n/g, ' | ')"))
    page.eval(f"Array.from(document.querySelectorAll('#lang-list li[data-code=\"{code}\"] button')).find((b) => b.textContent.indexOf('Download dictionary') === 0).click()")
    took = page.wait(f"document.body.dataset.lang === {json.dumps(code)} && document.body.dataset.ready === 'true'"
                     " || /HTTP|mismatch|cancelled|Could not/.test(document.getElementById('picker-status').textContent"
                     " + document.getElementById('status').textContent)", DOWNLOAD_TIMEOUT_S, "download")
    print(f"download ({took:.0f} s):", page.eval("document.getElementById('status').textContent"),
          "|", page.eval("document.getElementById('picker-status').textContent"))
    assert page.eval("document.body.dataset.lang") == code
    r = set_query(page, args.query)
    print(f"{args.query} ->", r)
    assert any(args.expect in row for row in r["first"][:1]), r
    dev.screenshot(args.shots / "04-download.png")

    # Entry pages are a second download, offered by the detail view.
    page.tap("#results li[data-index] .words")
    page.wait("document.body.dataset.details === 'none' && !!document.getElementById('detail-get-pages')", 60, "offer")
    print("detail without pages:", page.eval("document.getElementById('detail-get-pages').textContent"))
    page.tap("#detail-get-pages")
    took = page.wait("document.body.dataset.details === 'loaded'", DOWNLOAD_TIMEOUT_S, "entry pages")
    print(f"entry pages ({took:.0f} s):", page.eval("Array.from(document.querySelectorAll('#detail .detail-h'), (h) => h.textContent)"),
          "|", page.eval("(document.querySelector('#detail-senses li.sense') || {}).textContent"))
    dev.screenshot(args.shots / "04b-entry-pages.png")
    dev.adb("shell", "input", "keyevent", "KEYCODE_BACK")
    page.wait("document.getElementById('detail').hidden", 30, "back")

    page.eval("(() => { document.getElementById('gear').click(); document.querySelector('#opt-languages button[data-code=zh]').click(); })()")
    page.wait("document.body.dataset.lang === 'zh' && document.body.dataset.ready === 'true'", START_TIMEOUT_S, "switch")
    r = set_query(page, "nihao")
    print("switch back, nihao ->", r)
    assert r["first"][0].startswith("你好"), r
    dev.screenshot(args.shots / "05-back-to-chinese.png")
    print("OK")


if __name__ == "__main__":
    sys.exit(main())
