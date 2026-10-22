import { Ellipsis, Percent, Search, Store } from 'lucide-react';
import { NavLink } from 'react-router';
import { MoreSheet } from '@/components/site/MoreSheet';
import { MAIN_LINKS } from '@/components/site/nav';
import { cn } from '@/lib/utils';

const ICONS = { '/search': Search, '/deals': Percent, '/shops': Store } as const;

const item =
  'flex min-h-11 min-w-11 flex-1 flex-col items-center justify-center gap-0.5 rounded-xl px-2 py-1 text-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50';

/**
 * Phone navigation (below 768px): a floating bar with Search, Deals, Shops and More. Content scrolls
 * under it, so it uses the nearly opaque --bar fill (as the top nav) rather than see-through glass.
 */
export function BottomNav() {
  return (
    <nav
      aria-label="Mobile navigation"
      className="fixed inset-x-3 rounded-2xl border border-line bg-bar shadow-(--shadow) backdrop-blur-md bottom-[calc(0.75rem+env(safe-area-inset-bottom))] z-40 flex items-stretch justify-around gap-1 p-1 md:hidden"
    >
      {MAIN_LINKS.map(({ to, label }) => {
        const Icon = ICONS[to];
        return (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) => cn(item, isActive ? 'bg-secondary font-semibold text-ink' : 'text-muted-foreground')}
          >
            <Icon aria-hidden="true" className="size-5" />
            {label}
          </NavLink>
        );
      })}
      <MoreSheet
        trigger={
          <button type="button" className={cn(item, 'text-muted-foreground')}>
            <Ellipsis aria-hidden="true" className="size-5" />
            More
          </button>
        }
      />
    </nav>
  );
}
