#!/usr/bin/env node
// Best-effort: list build artifacts under dist/ after a pack so the operator
// can see what was produced. Safe to run even if dist/ is absent.
import fs from 'node:fs';
import path from 'node:path';

const dist = path.join(process.cwd(), 'dist');
if (!fs.existsSync(dist)) {
  process.exit(0);
}
const files = [];
for (const entry of fs.readdirSync(dist, { withFileTypes: true })) {
  if (entry.isFile()) {
    const stat = fs.statSync(path.join(dist, entry.name));
    files.push({ name: entry.name, size: stat.size });
  }
}
if (!files.length) {
  process.exit(0);
}
console.log('\nartifact(s):');
for (const f of files) {
  const kb = (f.size / 1024).toFixed(0);
  console.log(`  ${f.name}  (${kb} KB)`);
}
