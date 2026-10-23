#!/usr/bin/env python3
"""CPU profile of the page while it switches to a language and searches.

Usage: ADB=... python3 test/web/emulator_profile.py SERIAL [CODE QUERY [FROM]]

Needs the debug app installed with CODE and FROM (default en, house, zh)
downloaded (emulator_bigindex.py does that). Switches FROM -> CODE with the
query typed at once, records a DevTools CPU profile until the first results
plus 3 s, and prints the functions with the most self time and the long tasks.
"""
import collections
import sys
import time

import emulator


def main():
    serial = sys.argv[1]
    code, query = (sys.argv[2], sys.argv[3]) if len(sys.argv) > 3 else ("en", "house")
    src = sys.argv[4] if len(sys.argv) > 4 else "zh"
    dev = emulator.Device(serial)
    pkg = "pl.d33.wiktionary.debug"
    page = emulator.connect(dev, pkg)
    page.wait("document.body.dataset.ready === 'true'", 300, "start")
    if page.eval("document.body.dataset.lang") != src:
        page.eval(f"(() => {{ document.getElementById('gear').click(); document.querySelector('#opt-languages button[data-code={src}]').click(); }})()")
        page.wait(f"document.body.dataset.lang === '{src}' && document.body.dataset.ready === 'true'", 300, src)
    page.eval("""window.__long = []; new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__long.push([Math.round(e.startTime), Math.round(e.duration)]); }).observe({ entryTypes: ['longtask'] }); 1""")
    page.call("Profiler.enable")
    page.call("Profiler.setSamplingInterval", interval=500)
    page.call("Profiler.start")
    t0 = page.eval("performance.now()")
    page.eval(f"(() => {{ document.getElementById('gear').click(); document.querySelector('#opt-languages button[data-code={code}]').click(); }})()")
    page.eval(f"(() => {{ const q = document.getElementById('q'); q.value = '{query}'; q.dispatchEvent(new Event('input')); }})()")
    page.wait(f"!!window.__openStats && window.__openStats.code === '{code}' && !!window.__openStats.search", 120, "results")
    time.sleep(3)
    prof = page.call("Profiler.stop")["profile"]
    nodes = {n["id"]: n for n in prof["nodes"]}
    dt = collections.Counter()
    deltas = prof.get("timeDeltas", [])
    for sid, d in zip(prof.get("samples", []), deltas):
        dt[sid] += d
    by = collections.Counter()
    for nid, us in dt.items():
        f = nodes[nid]["callFrame"]
        by[f"{f['functionName'] or '(anon)'} {f['url'].split('/')[-1]}:{f['lineNumber'] + 1}"] += us
    print("self time (ms):")
    for name, us in by.most_common(15):
        print(f"  {us / 1000:8.1f}  {name}")
    print("long tasks [start ms after switch, duration ms]:", [[s - round(t0), d] for s, d in page.eval("window.__long")])
    print("open stats:", page.eval("JSON.stringify(window.__openStats.phases)"))


if __name__ == "__main__":
    sys.exit(main())
