#!/usr/bin/env python3
"""Emulator check of dictionary updates: German installed from the OLD data
release (data-2026-10-22, built before the recordings) is offered an
update by the current catalogue (header dot, note, "Update all" in Options
with its progress in the transfer tray), and after the update its entries
have speaker buttons.

Usage: ADB=... python3 test/web/emulator_update.py SERIAL DEBUG_APK SHOTS_DIR
"""
import json
import pathlib
import re
import sys
import time

import emulator

OLD = {"name": "de.idx", "path": "download/data-2026-10-22/de.idx.gz", "bytes": 65422596,
       "sha256": "a5273257b7b12ead97ab46ca0356b3d290b6a31a1ab130bf7fb2ddb43d672b59", "gzip": True}
OLD_SMJ = {"name": "smj.idx", "path": "download/data-2026-10-22/smj.idx.gz", "bytes": 107120,
           "sha256": "ec79db1c2df0a65e62a594da1f4f1d276b20d38633b1b47d6482ce5b4ef17687", "gzip": True}


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

    # Old German and Lule Sami indexes, stored the way the app stores downloads.
    for req in (OLD, OLD_SMJ):
        t0 = time.monotonic()
        result = page.eval("""new Promise((resolve) => {
          const previous = window.onNativeDownload;
          window.onNativeDownload = (id, state, done, total, error) => {
            if (id !== 'old') return previous && previous(id, state, done, total, error);
            if (state !== 'progress') { window.onNativeDownload = previous; resolve([state, error]); }
          };
          window.WiktionaryNative.startIndexDownload(JSON.stringify(Object.assign({ id: 'old' }, %s)));
        })""" % json.dumps(req))
        print(f"old {req['name']} from data-2026-10-22: {result} in {time.monotonic() - t0:.0f} s")
        assert result[0] == "done", result
    page.eval("""(() => { const s = JSON.parse(localStorage.getItem('wiktionary-lookup.state'));
      s.installed.de = { code: 'de', name: 'German', entries: 352562, bytes: %d, sha256: '%s', storage: 'file', kind: 'wiktionary', lang: 'de' };
      s.installed.smj = { code: 'smj', name: 'Lule Sami', entries: 855, bytes: %d, sha256: '%s', storage: 'file', kind: 'wiktionary', lang: 'smj' };
      s.active = 'de'; localStorage.setItem('wiktionary-lookup.state', JSON.stringify(s)); location.reload(); return 1; })()""" % (
        OLD["bytes"], OLD["sha256"], OLD_SMJ["bytes"], OLD_SMJ["sha256"]))
    time.sleep(3)
    page = emulator.connect(dev, pkg, restart=False)
    page.wait("!!document.body && document.body.dataset.lang === 'de' && document.body.dataset.ready === 'true'", 300, "de")
    print("old German, speaker buttons on Haus:", speakers(page, "Haus"))
    page.wait("document.body.dataset.updates === '2'", 120, "updates detected")
    print("2 updates detected: header dot", page.eval("!document.getElementById('lang-badge').hidden"),
          "| note:", page.eval("document.getElementById('notice').hidden ? '' : document.getElementById('notice').textContent"))
    dev.screenshot(shots / "update-1-badge.png")
    # "Update all" in Options: the transfer tray shows its progress and German's.
    page.eval("document.getElementById('gear').click(); 1")
    page.wait("!document.getElementById('update-all').hidden", 30, "Update all")
    print("options:", page.eval("document.getElementById('update-all').textContent"))
    page.tap("#update-all")
    t1 = time.monotonic()
    seen = []
    while not page.eval("document.body.dataset.updateAll === 'done' && document.body.dataset.ready === 'true'"):
        if time.monotonic() - t1 > 900:
            raise TimeoutError("update")
        tray = page.eval("""Array.from(document.querySelectorAll('#transfers .transfer'), (t) => {
            const b = t.querySelector('progress');
            return [t.dataset.transfer, b.hasAttribute('value') ? b.value / b.max : null, t.innerText.replace(/\\n/g, ' | ')]; })""")
        if tray:
            seen.append(tray)
            if len(seen) == 3:
                dev.screenshot(shots / "update-1b-progress.png")
        time.sleep(0.5)
    print(f"updated in {time.monotonic() - t1:.0f} s; header dot", page.eval("!document.getElementById('lang-badge').hidden"))
    partial = [t for snap in seen for t in snap if t[0] == "de" and t[1] is not None and 0 < t[1] < 1]
    print("tray samples:", len(seen), "| first:", seen[0] if seen else None, "| partial de:", partial[:1])
    assert any(t[0] == "update-all" for snap in seen for t in snap), seen[:3]
    assert partial, seen[:5]
    counters = sorted({int(re.search(r"(\d+) of 2 languages", t[2]).group(1)) for snap in seen for t in snap
                       if t[0] == "update-all" and re.search(r"(\d+) of 2 languages", t[2])})
    print("overall counter values seen:", counters)
    assert counters and counters[0] == 0, counters
    # Rows in the language list: both updated; the status sums up.
    page.eval("document.getElementById('opt-more').click(); 1")
    page.wait("!!document.querySelector('#lang-list li[data-code=de]')", 60, "rows")
    rows = {c: page.eval(f"(() => {{ const f = document.getElementById('lang-filter'); f.value = '{c}'; f.dispatchEvent(new Event('input'));"
                         f" const li = document.querySelector('#lang-list li[data-code={c}]'); return [li.dataset.update, li.innerText.replace(/\\n/g, ' | ')]; }})()")
            for c in ("de", "smj")}
    status = page.eval("document.getElementById('picker-status').textContent")
    print("rows after Update all:", rows, "| status:", status)
    assert all(r[0] == "done" for r in rows.values()), rows
    assert page.eval("document.body.dataset.updateAll") == "done"
    page.eval("document.getElementById('picker-close').click(); 1")
    n = speakers(page, "Haus")
    print("after the update, speaker buttons on Haus:", n)
    assert n == 1, n
    dev.screenshot(shots / "update-2-after.png")
    print("OK")


if __name__ == "__main__":
    sys.exit(main())
