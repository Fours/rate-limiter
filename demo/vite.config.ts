import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// The demo is a static site (decision 0024). It imports the library's source and Lua directly,
// so it always runs what's in this checkout, never a published copy.
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    // The demo imports ../src, outside its root.
    fs: { allow: [fileURLToPath(new URL('..', import.meta.url))] },
  },
});
