import { Link } from 'react-router';
import { Notice } from '@/components/site/DealList';
import { ShopBadge } from '@/components/site/ShopBadge';
import { Button } from '@/components/ui/button';
import { ApiError, api, type ShopSummary, useApi } from '@/lib/api';

const count = new Intl.NumberFormat('en-GB');

/** The small RATING letter of a shop, or "Not rated yet" (never a letter) when it has no grade. */
export function ShopGrade({ grade }: { grade: ShopSummary['grade'] }) {
  if (grade === null) return <span className="text-xs text-muted-foreground">Not rated yet</span>;
  return (
    <span className="flex items-baseline gap-1.5">
      <span aria-hidden="true" className="text-[10px] font-semibold tracking-widest text-muted-foreground">
        RATING
      </span>
      <span className="sr-only">Rating </span>
      <span className="text-xl leading-none font-extrabold" style={{ color: `var(--grade-${grade.toLowerCase()})` }}>
        {grade}
      </span>
    </span>
  );
}

function ShopRow({ shop }: { shop: ShopSummary }) {
  return (
    <li>
      <Link
        to={`/shops/${encodeURIComponent(shop.slug)}`}
        className="flex min-h-14 items-center gap-3 px-4 py-2 outline-none hover:bg-secondary focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:ring-inset"
      >
        <ShopBadge name={shop.name} logoUrl={shop.logoUrl} decorative />
        <span className="min-w-0 flex-1">
          <span className="block truncate font-semibold">{shop.name}</span>
          <span className="block text-xs text-muted-foreground">
            {count.format(shop.products)} {shop.products === 1 ? 'product' : 'products'}
          </span>
        </span>
        <ShopGrade grade={shop.grade} />
      </Link>
    </li>
  );
}

/** Shops: every shop we follow, in the order the API returns (by name), each linking to its page. */
export function ShopsPage() {
  const shops = useApi(
    'shops',
    (signal) => api.shops(signal),
    (d) => {
      if (!Array.isArray(d?.shops)) throw new ApiError(200); // a 200 without the expected shape
      return d.shops.length === 0;
    },
  );

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-bold tracking-tight">Shops</h1>
      {(shops.status === 'idle' || shops.status === 'loading') && (
        <div role="status" aria-label="Loading shops" className="glass h-56 opacity-60" />
      )}
      {shops.status === 'error' && (
        <Notice
          title="Shops could not be loaded."
          action={
            <Button variant="outline" className="min-h-11" onClick={shops.retry}>
              Try again
            </Button>
          }
        >
          Check your connection and try again.
        </Notice>
      )}
      {shops.status === 'empty' && <Notice title="No shops to show yet." />}
      {shops.status === 'ready' && (
        <ul className="glass m-0 list-none divide-y divide-line overflow-hidden p-0">
          {shops.data.shops.map((s) => (
            <ShopRow key={s.slug} shop={s} />
          ))}
        </ul>
      )}
    </div>
  );
}
