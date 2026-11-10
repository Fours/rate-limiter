/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_PUBLIC_POSTHOG_KEY?: string;
  readonly VITE_PUBLIC_POSTHOG_HOST?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

// The write-up's chart data, read from docs/decisions/data/ at build time (demo/vite.config.ts).
declare module 'virtual:writeup-data' {
  const data: import('./writeup/data.ts').WriteupData;
  export default data;
}
