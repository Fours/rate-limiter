// The write-up's own entry: no wasmoon and no simulation, so the page loads fast for a reader
// who came for the text. Its chart data is built in (virtual:writeup-data, demo/vite.config.ts).
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import data from 'virtual:writeup-data';
import { initAnalytics } from '../analytics.ts';
import '../styles.css';
import './writeup.css';
import { WriteUp } from './WriteUp.tsx';

const root = document.getElementById('root');
if (root === null) throw new Error('how-it-works/index.html has no #root');
createRoot(root).render(
  <StrictMode>
    <WriteUp data={data} />
  </StrictMode>,
);
initAnalytics();
