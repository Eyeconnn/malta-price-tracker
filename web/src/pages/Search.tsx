import { useEffect, useId, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { BlackFridayMark, NO_PRICE } from '@/components/site/DealCard';
import { Notice } from '@/components/site/DealList';
import { ProductImage, productPath, resultLabel, resultPrice, resultTitle, sellersLine, verdictNote, verdictParts } from '@/components/site/ProductResult';
import { SEARCH_DEBOUNCE_MS, SearchBox, SearchStatus, searchPath, useSearch } from '@/components/site/SearchBox';
import { Button } from '@/components/ui/button';
import { type ProductResult, useDebounced } from '@/lib/api';
import { cn } from '@/lib/utils';

const SLUG = /^[a-z0-9-]{1,64}$/;

/**
 * One product: its clean name (specs after a middle dot), the lowest price and how many shops sell it, Black
 * Friday and the sellers' verdicts. The title link is stretched over the whole card (its ::after fills the card,
 * which is positioned), so a tap anywhere opens the product page; it takes the taps, the hover tint and the focus
 * ring, so the glass card keeps its own shadow.
 */
function ProductCard({ result }: { result: ProductResult }) {
  const id = useId();
  const descId = useId();
  const description = [verdictNote(result), result.inStock ? '' : 'out of stock'].filter((x) => x !== '').join(', ');
  return (
    <article aria-labelledby={id} className="glass relative flex min-h-11 items-start gap-3.5 p-[18px]">
      <ProductImage url={result.imageUrl} alt="" size={64} className="size-16" />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <h2 id={id} className="text-[17px] leading-snug font-bold break-words">
          <Link
            to={productPath(result.key)}
            aria-label={resultLabel(result)}
            aria-describedby={description ? descId : undefined}
            className="rounded-sm text-ink outline-none after:absolute after:inset-0 after:rounded-[20px] after:content-[''] hover:underline hover:after:bg-secondary focus-visible:after:ring-[3px] focus-visible:after:ring-ring"
          >
            {resultTitle(result)}
          </Link>
        </h2>
        <p className="text-sm text-muted-foreground">{sellersLine(result)}</p>
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          {result.bf && <BlackFridayMark />}
          {verdictParts(result).map((p) => (
            <span key={p.text} className={cn('font-bold', p.tone === 'bad' ? 'text-bad' : 'text-good')}>
              {p.text}
            </span>
          ))}
          {!result.inStock && <span className="text-muted-foreground">Out of stock</span>}
        </div>
        {description && (
          <span id={descId} className="sr-only">
            {description}
          </span>
        )}
      </div>
      <p className="t-num max-w-32 flex-none text-right text-xl">
        {result.priceCents === null ? <span className="text-xs font-medium text-muted-foreground">{NO_PRICE}</span> : resultPrice(result)}
      </p>
    </article>
  );
}

/** Search: the query lives in ?q= (and an optional ?shop=); one result per product, whatever the number of shops. */
export function SearchPage() {
  const [params, setParams] = useSearchParams();
  const urlQuery = params.get('q') ?? '';
  const shopParam = params.get('shop');
  const shop = shopParam !== null && SLUG.test(shopParam) ? shopParam : null;
  const [value, setValue] = useState(urlQuery);
  const { term, state } = useSearch(value, shop);

  // Typing writes ?q= once it settles (replacing the entry, so Back leaves the page); a URL changed
  // from outside (Back, a link) replaces the text.
  const written = useRef(urlQuery);
  useEffect(() => {
    if (urlQuery !== written.current) {
      written.current = urlQuery;
      setValue(urlQuery);
    }
  }, [urlQuery]);
  const settled = useDebounced(value.trim(), SEARCH_DEBOUNCE_MS);
  useEffect(() => {
    if (settled === written.current) return;
    written.current = settled;
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (settled) next.set('q', settled);
        else next.delete('q');
        return next;
      },
      { replace: true },
    );
  }, [settled, setParams]);

  return (
    <>
      <h1 className="text-[26px] leading-tight font-bold tracking-[-0.01em] md:text-[32px]">Search</h1>
      <SearchBox
        animated
        value={value}
        onChange={setValue}
        onSubmit={(q) => {
          written.current = q;
          setParams(
            (prev) => {
              const next = new URLSearchParams(prev);
              if (q) next.set('q', q);
              else next.delete('q');
              return next;
            },
            { replace: true },
          );
        }}
      />
      <SearchStatus state={state} term={term} />
      {shop && (
        <p className="text-sm text-muted-foreground">
          Results from one shop only.{' '}
          <Link to={searchPath(value)} className="font-semibold text-brand underline-offset-2 hover:underline">
            Search all shops
          </Link>
        </p>
      )}
      {state.status !== 'idle' && (
        <section aria-label="Search results" className="flex flex-col gap-3">
          {state.status === 'loading' && (
            <div aria-hidden="true" className="flex flex-col gap-3">
              {[0, 1, 2].map((i) => (
                <div key={i} className="glass h-32 opacity-60" />
              ))}
            </div>
          )}
          {state.status === 'empty' && <Notice title={`No products match "${term}".`}>Try fewer words, or the brand and model.</Notice>}
          {state.status === 'error' && (
            <Notice
              title="Search is not available right now."
              action={
                <Button variant="outline" onClick={state.retry}>
                  Try again
                </Button>
              }
            />
          )}
          {state.status === 'ready' && (
            <>
              <p className="text-sm text-muted-foreground">
                {state.data.results.length === 1 ? '1 product' : `${state.data.results.length} products`}
              </p>
              {state.data.results.map((r) => (
                <ProductCard key={r.key} result={r} />
              ))}
            </>
          )}
        </section>
      )}
    </>
  );
}
