import { gzipSync } from 'node:zlib';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// Size budgets (spec v0.1.1): core <8kb, each format/adapter/provider <5kb, CLI <25kb (gzip).
// Reports only — exits 0. Budgets are aspirational until the treeshake/lazy-split pass;
// this script tracks progress run over run.
const BUDGETS = [
  { label: 'core (index)', files: ['dist/index.js'], kb: 8 },
  { label: 'node entry', files: ['dist/node.js'], kb: 12 },
  { label: 'cli', files: ['dist/cli/main.js'], kb: 25 },
];

const dist = join(process.cwd(), 'dist');
if (!existsSync(dist)) {
  console.log('size: dist/ missing, run build first. skipping.');
  process.exit(0);
}

function chunkImports(entryFile) {
  try {
    const text = readFileSync(join(process.cwd(), entryFile), 'utf8');
    const chunks = [...text.matchAll(/from\s*["']\.\.?\/([^"']+\.js)["']/g)].map((m) => m[1]);
    return [entryFile, ...chunks];
  } catch {
    return [entryFile];
  }
}

let over = 0;
for (const b of BUDGETS) {
  const seen = new Set();
  for (const f of b.files) for (const c of chunkImports(f)) seen.add(c);
  let bytes = 0;
  for (const c of seen) {
    const p = c.startsWith('dist/') ? join(process.cwd(), c) : join(dist, c);
    try {
      if (!statSync(p).isFile()) continue;
      bytes += gzipSync(readFileSync(p)).length;
    } catch {
      // ignore
    }
  }
  const kb = bytes / 1024;
  const ok = kb <= b.kb ? 'OK  ' : 'OVER';
  if (kb > b.kb) over++;
  console.log(`size: ${ok} ${b.label}: ${kb.toFixed(2)}kb gzip (budget ${b.kb}kb) [${[...seen].join(', ')}]`);
}

// Per-entry rollup for adapters/formats/vault (informational)
try {
  const dirs = ['adapters', 'formats', 'vault', 'framework', 'cli'];
  for (const d of dirs) {
    const p = join(dist, d);
    if (!existsSync(p) || !statSync(p).isDirectory()) continue;
    for (const f of readdirSync(p).filter((x) => x.endsWith('.js'))) {
      const bytes = gzipSync(readFileSync(join(p, f))).length;
      console.log(`size: info ${d}/${f}: ${(bytes / 1024).toFixed(2)}kb gzip`);
    }
  }
} catch {
  // ignore
}

if (over > 0) console.log(`size: ${over} budget(s) exceeded — tracking only, not failing.`);
process.exit(0);
