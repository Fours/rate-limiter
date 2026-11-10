// The app bar both pages share: the brand, which page this is, and links to the other page, npm
// and GitHub. The live demo and the write-up are separate pages of one site (spec T7).
import type { ReactNode } from 'react';
import { NPM_URL, REPO_URL } from '../links.ts';
import { ExternalIcon, GaugeIcon } from './icons.tsx';
import './app-bar.css';

/** Relative, so the links work wherever the site is served from. */
const PAGES = {
  demo: { href: '../', label: 'Live demo' },
  'how-it-works': { href: 'how-it-works/', label: 'How it works' },
} as const;

export type Page = keyof typeof PAGES;

export function AppBar({ page, status }: { page: Page; status?: ReactNode }) {
  const other: Page = page === 'demo' ? 'how-it-works' : 'demo';
  return (
    <header className="app-bar">
      <div className="brand">
        <span className="brand-mark">
          <GaugeIcon size={18} />
        </span>
        <span className="brand-name">Rate limiter</span>
        <span className="brand-sep" aria-hidden="true">
          /
        </span>
        <span className="brand-page">{PAGES[page].label}</span>
        {status}
      </div>
      <nav className="app-links" aria-label="Project">
        <a href={PAGES[other].href}>{PAGES[other].label}</a>
        <a className="npm-link" href={NPM_URL} target="_blank" rel="noreferrer">
          npm <ExternalIcon size={13} />
        </a>
        <a href={REPO_URL} target="_blank" rel="noreferrer">
          GitHub <ExternalIcon size={13} />
        </a>
      </nav>
    </header>
  );
}
