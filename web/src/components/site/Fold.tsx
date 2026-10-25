import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * A part that opens and closes with a height, fade and small slide (CSS grid rows 0fr to 1fr, `.fold` in
 * styles.css). Closed, it is inert and hidden from assistive tech. `stacked`: a closed fold in a gapped column also
 * takes back the gap above it, so nothing jumps.
 */
export function Fold({ open, children, id, stacked = false, className }: { open: boolean; children: ReactNode; id?: string; stacked?: boolean; className?: string }) {
  return (
    <div id={id} data-open={open ? 'true' : undefined} aria-hidden={open ? undefined : true} inert={!open} className={cn('fold', stacked && 'fold-stacked', className)}>
      <div className="fold-inner">{children}</div>
    </div>
  );
}
