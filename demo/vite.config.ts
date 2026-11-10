import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import { DATA_DIR, SOURCES, loadWriteupData } from './build/writeup-data.ts';

const page = (path: string) => fileURLToPath(new URL(path, import.meta.url));

// The write-up's charts are read from docs/decisions/data/ at build time (spec T7), so they can't
// drift from the records. A missing source throws, which fails the build.
function writeupData(): Plugin {
  const id = 'virtual:writeup-data';
  return {
    name: 'writeup-data',
    resolveId: (source) => (source === id ? `\0${id}` : undefined),
    load(resolved) {
      if (resolved !== `\0${id}`) return undefined;
      for (const source of Object.values(SOURCES)) this.addWatchFile(join(DATA_DIR, source));
      return `export default ${JSON.stringify(loadWriteupData())};`;
    },
  };
}

// The demo is a static site (decision 0024). It imports the library's source and Lua directly,
// so it always runs what's in this checkout, never a published copy. Two pages: the live demo,
// and the write-up at how-it-works/, which loads neither wasmoon nor the simulation.
export default defineConfig({
  root: page('.'),
  plugins: [react(), writeupData()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rolldownOptions: {
      input: {
        demo: page('index.html'),
        howItWorks: page('how-it-works/index.html'),
      },
    },
  },
  server: {
    // The demo imports ../src, outside its root.
    fs: { allow: [page('..')] },
  },
});
