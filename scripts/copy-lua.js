// tsc only emits .js and .d.ts, so copy the Lua scripts next to their compiled modules in
// dist/. Each module reads its script with new URL('./name.lua', import.meta.url).
import { cpSync, statSync } from 'node:fs';

cpSync('src', 'dist', {
  recursive: true,
  filter: (path) => statSync(path).isDirectory() || path.endsWith('.lua'),
});
