// Checks what `npm pack` would publish: only dist/, the README, the licence, the changelog and
// package.json, and the files the package can't work without. Run after `npm run build`.
import { execFileSync } from 'node:child_process';
import console from 'node:console';
import { readFileSync } from 'node:fs';
import process from 'node:process';

const ALLOWED_TOP_LEVEL = new Set(['README.md', 'LICENSE', 'CHANGELOG.md', 'package.json']);

// tsc doesn't copy Lua, so the scripts are listed to prove the build step put them there.
const REQUIRED = [
  'dist/index.js',
  'dist/index.d.ts',
  'dist/prometheus.js',
  'dist/prometheus.d.ts',
  ...[
    'token-bucket',
    'leaky-bucket',
    'fixed-window',
    'sliding-window-log',
    'sliding-window-counter',
  ].map((name) => `dist/algorithms/redis/${name}.lua`),
  ...ALLOWED_TOP_LEVEL,
];

const output = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
  encoding: 'utf8',
});
const files = JSON.parse(output)[0].files.map((file) => file.path);

const stray = files.filter((path) => !path.startsWith('dist/') && !ALLOWED_TOP_LEVEL.has(path));
const missing = REQUIRED.filter((path) => !files.includes(path));

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const problems = [
  ...stray.map((path) => `ships a file outside dist/: ${path}`),
  ...missing.map((path) => `doesn't ship ${path}`),
];
// prom-client stays out of the core (decision 0005): an optional peer dependency only.
if (pkg.dependencies?.['prom-client'] !== undefined)
  problems.push('prom-client is in dependencies');
if (pkg.peerDependenciesMeta?.['prom-client']?.optional !== true) {
  problems.push('prom-client must be an optional peer dependency');
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`check-pack: ${problem}`);
  process.exit(1);
}
console.log(`check-pack: ${String(files.length)} files, all expected`);
