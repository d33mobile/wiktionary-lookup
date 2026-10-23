#!/usr/bin/env python3
"""Emulator measurement of a large index (English Wiktionary, 261 MB).

Usage: ADB=... python3 test/web/emulator_bigindex.py SERIAL DEBUG_APK [CODE QUERY]

Downloads CODE (default en) through the app into its storage (skipped when
already there), then switches to it and measures: how long the page's main
thread stays unresponsive while the index opens (the worst delay of a probe
evaluated every 50 ms), the time until a query typed at once shows
results, and the memory of the app and its renderer. Also compares reading
4 MiB from the stored file through /local/?offset=&length= and through the
bridge (base64).
"""
import json
import re
import sys
import threading
import time

import emulator


def pss(dev, pattern):
    """MiB of PSS of the processes whose name contains pattern (dumpsys meminfo summary)."""
    out = dev.adb("shell", "dumpsys", "meminfo", check=False, text=True)
    seen = {}
    # The summary lists processes once per section (by process, by OOM level); count each pid once.
    for m in re.finditer(r"^\s*([\d,]+)K: (\S+) \(pid (\d+)", out, re.M):
        if pattern in m.group(2):
            seen.setdefault(m.group(3), int(m.group(1).replace(",", "")))
    return sum(seen.values()) // 1024 or None


def main():
    serial, apk = sys.argv[1], sys.argv[2]
    code, query = (sys.argv[3], sys.argv[4]) if len(sys.argv) > 4 else ("en", "house")
    dev = emulator.Device(serial)
    pkg = "pl.d33.wiktionary.debug"
    dev.adb("root", check=False)
    time.sleep(3)
    dev.adb("wait-for-device")
    print(dev.adb("install", "-r", apk, text=True).strip())
    page = emulator.connect(dev, pkg)
    page.wait("!!document.body && (document.body.dataset.screen === 'welcome' || document.body.dataset.ready === 'true')", 300, "start")
    emulator.past_welcome(page)
    if page.eval(f"window.WiktionaryNative.indexFileSize('{code}.idx')") < 0:
        page.eval("(() => { document.getElementById('gear').click(); document.getElementById('opt-more').click(); })()")
        page.wait("/languages available/.test(document.getElementById('picker-status').textContent)", 120, "manifest")
        page.eval(f"(() => {{ const f = document.getElementById('lang-filter'); f.value = '{code}'; f.dispatchEvent(new Event('input')); }})()")
        page.eval(f"Array.from(document.querySelectorAll('#lang-list li[data-code=\"{code}\"] button')).find((b) => /^Download dictionary/.test(b.textContent)).click()")
        time.sleep(1)
        page.eval(f"(() => {{ const b = Array.from(document.querySelectorAll('#lang-list li[data-code=\"{code}\"] button')).find((x) => x.textContent === 'Download anyway'); if (b) b.click(); }})()")
        t0 = time.monotonic()
        page.wait(f"document.body.dataset.lang === '{code}' && document.body.dataset.ready === 'true'", 1800, "download")
        print(f"downloaded {code} through the app in {time.monotonic() - t0:.0f} s:",
              page.eval(f"window.WiktionaryNative.indexFileSize('{code}.idx')"), "bytes")
        page.eval("(() => { document.getElementById('gear').click(); document.querySelector('#opt-languages button[data-code=zh]').click(); })()")
        page.wait("document.body.dataset.lang === 'zh' && document.body.dataset.ready === 'true'", 120, "zh")

    rss_before = pss(dev, pkg)
    renderer_before = pss(dev, "sandboxed_process")
    # Probe the main thread while switching: an eval every 50 ms.
    delays = []
    stop = threading.Event()
    probe = emulator.connect(dev, pkg, restart=False)

    def probing():
        while not stop.is_set():
            t = time.monotonic()
            probe.eval("1")
            delays.append(time.monotonic() - t)
            time.sleep(0.05)

    thread = threading.Thread(target=probing)
    thread.start()
    t0 = time.monotonic()
    page.eval(f"(() => {{ document.getElementById('gear').click(); document.querySelector('#opt-languages button[data-code={code}]').click(); }})()")
    page.eval(f"(() => {{ const q = document.getElementById('q'); q.value = '{query}'; q.dispatchEvent(new Event('input')); }})()")
    accepted = time.monotonic() - t0
    page.wait("document.querySelectorAll('#results li[data-index]').length > 0", 300, "results")
    first_results = time.monotonic() - t0
    page.wait("document.body.dataset.ready === 'true'", 300, "open")
    opened = time.monotonic() - t0
    stop.set()
    thread.join()
    print(f"switch to {code} and type {query!r}: input accepted after {accepted * 1000:.0f} ms, results after "
          f"{first_results:.2f} s, open finished after {opened:.2f} s ({page.eval('document.body.dataset.opened')})")
    print(f"main thread probe: {len(delays)} probes, worst {max(delays) * 1000:.0f} ms, median "
          f"{sorted(delays)[len(delays) // 2] * 1000:.0f} ms")
    print("status:", page.eval("document.getElementById('status').textContent"))
    print("first result:", page.eval("document.querySelector('#results li[data-index]').innerText.split('\\n')[0]"))
    print("open stats (cold or as found):", json.dumps(page.eval("window.__openStats")))

    def switch(to, q, label):
        t = time.monotonic()
        page.eval(f"(() => {{ document.getElementById('gear').click(); document.querySelector('#opt-languages button[data-code={to}]').click(); }})()")
        page.eval(f"(() => {{ const q = document.getElementById('q'); q.value = '{q}'; q.dispatchEvent(new Event('input')); }})()")
        page.wait(f"document.body.dataset.lang === '{to}' && !!window.__openStats && window.__openStats.code === '{to}' && !!window.__openStats.search", 300, label)
        st = page.eval("window.__openStats")
        print(f"{label}: wall {time.monotonic() - t:.2f} s | {json.dumps({k: st[k] for k in ('phases', 'open', 'search')})}")
        page.wait("document.body.dataset.ready === 'true'", 300, label)

    switch("zh", "hao", "zh open")
    # Cold: the kernel's page cache dropped (needs adb root, emulator images without Play allow it).
    dropped = dev.adb("shell", "sync; echo 3 > /proc/sys/vm/drop_caches && echo dropped", check=False, text=True).strip()
    switch(code, query, f"{code} open, page cache {'dropped' if dropped == 'dropped' else 'not dropped (no root)'}")
    switch("zh", "hao", "zh open")
    switch(code, query, f"{code} open, warm")
    time.sleep(2)
    print(f"PSS app process: {rss_before} MiB before, {pss(dev, pkg)} MiB after; WebView renderer: "
          f"{renderer_before} MiB before, {pss(dev, 'sandboxed_process')} MiB after")

    bench = page.eval(f"""(async () => {{
      const name = '{code}.idx', n = 4 * 1048576, out = {{}};
      let t = performance.now();
      const r = await fetch('/local/' + name + '?offset=1000000&length=' + n);
      const a = new Uint8Array(await r.arrayBuffer());
      out.range = [r.status, a.length, Math.round(performance.now() - t)];
      t = performance.now();
      const b64 = window.WiktionaryNative.readIndexRange(name, 1000000, n);
      const bin = atob(b64); const b = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
      out.bridge = [b.length, Math.round(performance.now() - t)];
      out.same = a.every((x, i) => x === b[i]);
      return out;
    }})()""")
    print("read 4 MiB: /local/?offset&length [status, bytes, ms] =", bench["range"], "| bridge base64 [bytes, ms] =",
          bench["bridge"], "| identical:", bench["same"])
    print("OK")


if __name__ == "__main__":
    sys.exit(main())
