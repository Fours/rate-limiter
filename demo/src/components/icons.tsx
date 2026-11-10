// Small line icons, drawn inline so the page needs no icon font or extra request. Each takes the
// current text colour and is hidden from screen readers: the text beside it carries the meaning.
import type { ReactNode } from 'react';

function Icon({ children, size = 16 }: { children: ReactNode; size?: number | undefined }) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

/** The brand mark: a gauge with its needle short of the red. */
export const GaugeIcon = ({ size }: { size?: number | undefined }) => (
  <Icon size={size}>
    <path d="M4 17a8 8 0 1 1 16 0" />
    <path d="M12 17l4-5" />
    <circle cx="12" cy="17" r="1.2" fill="currentColor" />
  </Icon>
);

export const ServerIcon = ({ size }: { size?: number | undefined }) => (
  <Icon size={size}>
    <rect x="3" y="4" width="18" height="7" rx="2" />
    <rect x="3" y="13" width="18" height="7" rx="2" />
    <path d="M7 7.5h.01M7 16.5h.01" />
  </Icon>
);

export const DatabaseIcon = ({ size }: { size?: number | undefined }) => (
  <Icon size={size}>
    <ellipse cx="12" cy="5.5" rx="8" ry="2.5" />
    <path d="M4 5.5v13c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5v-13" />
    <path d="M4 12c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5" />
  </Icon>
);

/** One path in, three out: the load balancer. */
export const SplitIcon = ({ size }: { size?: number | undefined }) => (
  <Icon size={size}>
    <path d="M12 3v6" />
    <path d="M12 9c0 4-7 4-7 9M12 9c0 4 7 4 7 9M12 9v9" />
    <circle cx="12" cy="3" r="0.5" fill="currentColor" />
  </Icon>
);

export const SendIcon = ({ size }: { size?: number | undefined }) => (
  <Icon size={size}>
    <path d="M5 12h13" />
    <path d="M13 6l6 6-6 6" />
  </Icon>
);

export const ExternalIcon = ({ size = 14 }: { size?: number | undefined }) => (
  <Icon size={size}>
    <path d="M14 4h6v6" />
    <path d="M20 4l-9 9" />
    <path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
  </Icon>
);

export const ChevronIcon = ({ size = 14 }: { size?: number | undefined }) => (
  <Icon size={size}>
    <path d="M9 6l6 6-6 6" />
  </Icon>
);

export const CloseIcon = ({ size = 16 }: { size?: number | undefined }) => (
  <Icon size={size}>
    <path d="M6 6l12 12M18 6L6 18" />
  </Icon>
);

export const SplitWindowIcon = ({ size }: { size?: number | undefined }) => (
  <Icon size={size}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M12 4v16" strokeDasharray="2 2.5" />
  </Icon>
);
