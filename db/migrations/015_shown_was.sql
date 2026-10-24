-- 015: where a night's was price came from, and the feed's own regular price for audit.
-- Safe to run again.
--
-- The site tests the was price a shopper sees struck through against the EU 30-day lowest price rule. Some shops show
-- a different reference price than their feed's regular price: AtoZ's Store API said regular_price 809.00 for the
-- Lenovo V15 G5 IRL (product 261895) on 23 and 24 Oct while its page showed "List Price" 969.00 struck through.
-- Shops whose config has shown_was (shops.config -> 'shown_was', see src/adapters/shownWas.ts) now record the shown
-- struck-through price.
--
-- was_source            feed   was_price_cents is the shop feed's regular / compare-at price (every adapter until now)
--                       shown  was_price_cents is the price the shop shows struck through (null: none shown)
--                       null   rows written before this migration (feed values)
-- feed_was_price_cents  the feed's regular price on a shown row (audit; null when the feed had none above the price)
--
-- Verdicts and the site's price history treat the was price of a shop with shown_was as unknown on every row whose
-- was_source is not 'shown' (src/site/build.ts toObs, web/worker/data.ts), so the past feed values of those shops never
-- feed a verdict. No row is deleted or changed except for the labels below.

alter table price_observations
  add column if not exists was_source text check (was_source in ('feed', 'shown')),
  add column if not exists feed_was_price_cents integer;

-- AtoZ's past rows: their was prices came from the feed, not from the page. Labelled for audit (the verdict rule above
-- already ignores them); the feed value is copied into feed_was_price_cents so the columns read the same as new rows.
update price_observations o
set was_source = 'feed',
    feed_was_price_cents = coalesce(o.feed_was_price_cents, o.was_price_cents)
from products p
join shops s on s.id = p.shop_id
where o.product_id = p.id and s.slug = 'atoz' and o.was_source is null;
