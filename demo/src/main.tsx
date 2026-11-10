import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { initAnalytics } from './analytics.ts';
import { App } from './App.tsx';
import './styles.css';

const root = document.getElementById('root');
if (root === null) throw new Error('index.html has no #root');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
initAnalytics();
