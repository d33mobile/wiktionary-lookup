#!/usr/bin/env python3
"""Emulator check of dictionary updates: German installed from the OLD data
release (data-2026-10-22, built before the recordings) is offered an
update by the current catalogue (header dot, note, Update), and after the
update its entries have speaker buttons.

Usage: ADB=... python3 test/web/emulator_update.py SERIAL DEBUG_APK SHOTS_DIR
"""
import json
import pathlib
import sys
import time

import emulator

OLD = {"name": "de.idx", "path": "download/data-2026-10-22/de.idx.gz", "bytes": 65422596,
       "sha256": "a5273257b7b12ead97ab46ca0356b3d290b6a31a1ab130bf7fb2ddb43d672b59", "gzip": True}


def speakers(page, word):
    emulator.set_query(page, word)
    page.wait("document.querySelectorAll('#results li[data-index]').length > 0", 60, "results")
    return page.eval("document.querySelectorAll('#results li[data-index]')[0].querySelectorAll('button.speak-audio').length")


def main():
    serial, apk, shots = sys.argv[1], sys.argv[2], pathlib.Path(sys.argv[3])
    shots.mkdir(parents=True, exist_ok=True)
    dev = emulator.Device(serial)
    pkg = "pl.d33.wiktionary.debug"
    print(dev.adb("install", "-r", apk, text=True).strip())
    dev.adb("shell", "pm", "clear", pkg)
    page = emulator.connect(dev, pkg)
    page.wait("!!document.body && document.body.dataset.screen === 'welcome'", 300, "welcome")
    emulator.past_welcome(page)

    # The old German index, stored the way the app stores downloads.
    t0 = time.monotonic()
    result = page.eval("""new Promise((resolve) => {
      const previous = window.onNativeDownload;
      window.onNativeDownload = (id, state, done, total, error) => {
        if (id !== 'old') return previous && previous(id, state, done, total, error);
        if (state !== 'progress') { window.onNativeDownload = previous; resolve([state, error]); }
      };
      window.WiktionaryNative.startIndexDownload(JSON.stringify(Object.assign({ id: 'old' }, %s)));
    })""" % json.dumps(OLD))
    print(f"old de from data-2026-10-22: {result} in {time.monotonic() - t0:.0f} s")
    assert result[0] == "done", result
    page.eval("""(() => { const s = JSON.parse(localStorage.getItem('wiktionary-lookup.state'));
      s.installed.de = { code: 'de', name: 'German', entries: 352562, bytes: %d, sha256: '%s', storage: 'file', kind: 'wiktionary', lang: 'de' };
      s.active = 'de'; localStorage.setItem('wiktionary-lookup.state', JSON.stringify(s)); location.reload(); return 1; })()""" % (OLD["bytes"], OLD["sha256"]))
    time.sleep(3)
    page = emulator.connect(dev, pkg, restart=False)
    page.wait("!!document.body && document.body.dataset.lang === 'de' && document.body.dataset.ready === 'true'", 300, "de")
    print("old German, speaker buttons on Haus:", speakers(page, "Haus"))
    page.wait("document.body.dataset.updates === '1'", 120, "update detected")
    print("update detected: header dot", page.eval("!document.getElementById('lang-badge').hidden"),
          "| note:", page.eval("document.getElementById('notice').hidden ? '' : document.getElementById('notice').textContent"))
    dev.screenshot(shots / "update-1-badge.png")
    page.eval("(() => { document.getElementById('gear').click(); document.getElementById('opt-more').click(); })()")
    page.wait("!!document.querySelector('#lang-list li[data-code=de]')", 60, "row")
    print("row:", page.eval("document.querySelector('#lang-list li[data-code=de]').innerText.replace(/\\n/g, ' | ')"))
    page.eval("Array.from(document.querySelectorAll('#lang-list li[data-code=de] button')).find((b) => /^Update/.test(b.textContent)).click()")
    t1 = time.monotonic()
    page.wait("document.body.dataset.updates === '0' && document.body.dataset.ready === 'true'", 900, "update")
    print(f"updated in {time.monotonic() - t1:.0f} s; header dot", page.eval("!document.getElementById('lang-badge').hidden"))
    page.eval("document.getElementById('picker-close').click(); 1")
    n = speakers(page, "Haus")
    print("after the update, speaker buttons on Haus:", n)
    assert n == 1, n
    dev.screenshot(shots / "update-2-after.png")
    print("OK")


if __name__ == "__main__":
    sys.exit(main())
