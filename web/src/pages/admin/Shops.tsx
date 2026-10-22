// Admin shops: every shop, with a switch that hides it from the public site.
import { useId, useState } from 'react';
import { Notice } from '@/components/site/DealList';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { type AdminShop, adminApi, adminErrorText } from '@/lib/admin-api';
import { useApi } from '@/lib/api';
import { SaveMessage, Section, useSaver } from './shared';

function ShopRow({ shop }: { shop: AdminShop }) {
  const [hidden, setHidden] = useState(shop.hidden);
  const [state, run] = useSaver();
  const id = useId();
  return (
    <li className="flex flex-wrap items-center gap-3 py-3">
      <span className="min-w-0 flex-1">
        <span className="block font-semibold break-words">{shop.name}</span>
        <span className="block text-xs text-muted-foreground">
          {shop.slug} | {shop.products === 1 ? '1 product' : `${shop.products} products`}
          {!shop.active && ' | not scraped (inactive)'}
        </span>
      </span>
      <span className="flex items-center gap-2">
        <Switch
          id={id}
          checked={hidden}
          disabled={state.kind === 'saving'}
          onCheckedChange={async (v) => {
            if (await run(() => adminApi.setShopHidden(shop.slug, v), v ? 'Hidden.' : 'Shown.')) setHidden(v);
          }}
        />
        <label htmlFor={id} className="text-sm">
          Hidden from the site<span className="sr-only">: {shop.name}</span>
        </label>
      </span>
      <span className="basis-full sm:basis-auto">
        <SaveMessage state={state} />
      </span>
    </li>
  );
}

export function AdminShopsPage() {
  const shops = useApi('admin-shops', (signal) => adminApi.shops(signal));
  return (
    <Section title="Shops" description="A hidden shop disappears from every list, search and page. Cached pages catch up within 10 minutes.">
      {(shops.status === 'loading' || shops.status === 'idle') && <div role="status" aria-label="Loading shops" className="glass h-40 opacity-60" />}
      {shops.status === 'error' && (
        <Notice
          title="Shops could not be loaded."
          action={
            <Button variant="outline" className="min-h-11" onClick={shops.retry}>
              Try again
            </Button>
          }
        >
          {adminErrorText(shops.error)}
        </Notice>
      )}
      {shops.status === 'ready' && (
        <ul className="m-0 list-none divide-y divide-line p-0">
          {shops.data.shops.map((s) => (
            <ShopRow key={s.slug} shop={s} />
          ))}
        </ul>
      )}
    </Section>
  );
}
