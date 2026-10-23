#!/usr/bin/env python3
"""Regenerates zh-details.jsonl, the kaikki.org Chinese records of a few words
for the web test of the detail page (你好 with its example, 好, 您好):

  python3 test/web/fixtures/make-zh-details-fixture.py /mnt/biglinks/wiktionary/kaikki/zh.jsonl
"""
import json
import pathlib
import sys

WORDS = {"你好", "好", "您好", "好久", "不見", "不见"}
out = pathlib.Path(__file__).with_name("zh-details.jsonl")
kept = []
with open(sys.argv[1], encoding="utf-8") as f:
    for line in f:
        if not any(f'"word": "{w}"' in line for w in WORDS):
            continue
        rec = json.loads(line)
        if rec.get("word") in WORDS:
            kept.append(line if line.endswith("\n") else line + "\n")
out.write_text("".join(kept), encoding="utf-8")
print(f"{len(kept)} records, {out.stat().st_size} bytes -> {out}")
