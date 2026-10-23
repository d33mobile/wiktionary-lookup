#!/usr/bin/env node
// Usage: node test/web/build-fixture.mjs SOURCE FILE OUT [sidecar|embedded|none]
// Builds a test index through build-index.js's exported functions (OUT and,
// for 'sidecar', the OUT .details file next to it).
import { buildIndex, loadSource, writeIndexFiles } from '../../build-index.js';

const [sourceName, file, out, mode = 'sidecar'] = process.argv.slice(2);
const source = await loadSource(sourceName);
const info = {};
const sections = await buildIndex(source.entries(file, info, mode === 'none' ? { details: false } : {}), info);
for (const w of await writeIndexFiles(sections, info, out, mode)) console.log(`wrote ${w.path}`);
