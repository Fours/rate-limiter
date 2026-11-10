import type { ReactNode } from 'react';
import { recordUrl, type RecordId } from './records.ts';

/**
 * A link to a decision record. With no children it reads as a citation, "0008"; with children,
 * the children are the link text.
 */
export function Record({ id, children }: { id: RecordId; children?: ReactNode }) {
  return (
    <a
      className={children === undefined ? 'record' : undefined}
      href={recordUrl(id)}
      data-record={id}
      target="_blank"
      rel="noreferrer"
    >
      {children ?? id}
    </a>
  );
}
