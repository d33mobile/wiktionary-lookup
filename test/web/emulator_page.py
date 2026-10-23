#!/usr/bin/env python3
"""Emulator check of the in-app Wiktionary page panel.

Usage: ADB=... python3 test/web/emulator_page.py SERIAL DEBUG_APK SHOTS_DIR

Opens 你好's entry page, waits for its Wiktionary page to be prefetched in
the hidden panel, taps "Open on Wiktionary" and requires the panel with
the page title within 1 s (PANEL_LIMIT_S overrides it, for emulators without
hardware acceleration); the Back key closes it. Then, without network,
another entry's page shows the panel's fallback (failed load).
"""
import json
import os
import pathlib
import sys
import time

import emulator


def state(page):
    return json.loads(page.eval("window.WiktionaryNative.pageState()"))


def tap_link(page, until, timeout_s):
    """Taps "Open on Wiktionary"; a tap measured just before the entry page
    moved (a status line, a late re-render) misses, so one more tap after 5 s."""
    for attempt in (1, 2):
        page.tap(".wiktionary-link")
        t0 = time.monotonic()
        while time.monotonic() - t0 < (5 if attempt == 1 else timeout_s):
            st = state(page)
            if until(st):
                return st
            time.sleep(0.05)
        print("tap_link: no reaction to the tap, tapping again")
    raise TimeoutError(state(page))


def main():
    serial, apk, shots = sys.argv[1], sys.argv[2], pathlib.Path(sys.argv[3])
    shots.mkdir(parents=True, exist_ok=True)
    dev = emulator.Device(serial)
    pkg = "pl.d33.wiktionary.debug"
    print(dev.adb("install", "-r", apk, text=True).strip())
    dev.adb("shell", "pm", "clear", pkg)
    dev.adb("shell", "svc", "wifi", "enable")
    dev.adb("shell", "svc", "data", "enable")
    emulator.wait_network(dev)
    page = emulator.connect(dev, pkg)
    page.wait("!!document.body && document.body.dataset.screen === 'welcome'", 300, "welcome")
    emulator.past_welcome(page)
    # PANEL_MODE: drawn (default) or gone (0.9); the app reads it at start.
    mode = os.environ.get("PANEL_MODE", "drawn")
    page.eval(f"window.WiktionaryNative.setPanelMode('{mode}'); 1")
    page = emulator.connect(dev, pkg)
    page.wait("!!document.body && document.body.dataset.ready === 'true'", 300, "restart")
    print("panel mode:", json.loads(page.eval("window.WiktionaryNative.panelDiagnostics()"))["mode"])

    emulator.set_query(page, "nihao")
    page.tap("#results li[data-index] .words")
    emulator.open_entry_pages(page, "你好")
    t0 = time.monotonic()
    while True:
        st = state(page)
        if st["progress"] == 100 and st["title"]:
            break
        if time.monotonic() - t0 > 60:
            raise TimeoutError(st)
        time.sleep(0.5)
    print(f"prefetched in the hidden panel after {time.monotonic() - t0:.1f} s:", st)
    t = time.monotonic()
    state(page)
    print(f"one panel state poll takes {(time.monotonic() - t) * 1000:.0f} ms")
    limit = float(os.environ.get("PANEL_LIMIT_S", "1.0"))
    t1 = time.monotonic()
    page.tap(".wiktionary-link")
    while not state(page)["visible"]:
        if time.monotonic() - t1 > max(5, 2 * limit):
            raise TimeoutError(state(page))
        time.sleep(0.05)
    shown = time.monotonic() - t1
    st = state(page)
    print(f"tap -> panel visible after {shown * 1000:.0f} ms with title {st['title']!r}")
    assert shown < limit and st["title"], (limit, st)
    time.sleep(1)
    diag = json.loads(page.eval("window.WiktionaryNative.panelDiagnostics()"))
    print("diagnostics (prefetched):", diag)
    assert diag["lastShow"]["finishedAtTap"] and diag["lastShow"]["progressAtTap"] == 100, diag
    dev.screenshot(shots / "page-panel.png")
    dev.adb("shell", "input", "keyevent", "KEYCODE_BACK")
    time.sleep(1)
    assert not state(page)["visible"], state(page)
    assert page.eval("document.body.dataset.detail") == "你好"
    print("Back key -> panel closed, entry page still there")

    # A page that has not finished loading: the panel appears at once with its progress bar.
    page.tap("#back")
    emulator.set_query(page, "zhongguo")
    page.tap("#results li[data-index] .words")
    # Tap once the entry page stopped re-rendering (its details arrived), not the page panel.
    page.wait("document.body.dataset.detail === '中国' && document.body.dataset.details !== 'loading'", 30, "中国")
    t2 = time.monotonic()
    tap_link(page, lambda st: st["visible"], max(5, 2 * limit))
    print(f"tap before the page loaded -> panel visible after {(time.monotonic() - t2) * 1000:.0f} ms")
    time.sleep(1)
    diag = json.loads(page.eval("window.WiktionaryNative.panelDiagnostics()"))
    print("diagnostics (not prefetched):", diag)
    dev.screenshot(shots / "page-panel-loading.png")
    dev.adb("shell", "input", "keyevent", "KEYCODE_BACK")
    time.sleep(1)
    assert not state(page)["visible"], state(page)

    dev.adb("shell", "svc", "wifi", "disable")
    dev.adb("shell", "svc", "data", "disable")
    try:
        time.sleep(3)
        page.tap("#back")
        emulator.set_query(page, "xuexi")
        page.tap("#results li[data-index] .words")
        page.wait("document.body.dataset.detail === '学习' && document.body.dataset.details !== 'loading'", 30, "entry page")
        tap_link(page, lambda st: st["failed"], 30)
        print("no network ->", state(page))
        time.sleep(1)
        dev.screenshot(shots / "page-panel-offline.png")
    finally:
        # Later tests need the network, also after a failure here.
        dev.adb("shell", "svc", "wifi", "enable")
        dev.adb("shell", "svc", "data", "enable")
        print(f"network back after {emulator.wait_network(dev):.0f} s")
    print("OK")


if __name__ == "__main__":
    sys.exit(main())
