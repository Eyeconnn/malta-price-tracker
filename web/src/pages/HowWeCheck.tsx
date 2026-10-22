// How we check: the rules behind every verdict, rating and match, in plain words.
// Every statement mirrors src/site/verdict.ts, rating.ts and matching.ts. The numbers are the live
// thresholds from GET /api/thresholds; the defaults show while loading or when the call fails.
import { type ReactNode, useId } from 'react';
import { GlassCard } from '@/components/site/GlassCard';
import { api, useApi } from '@/lib/api';
import { DEFAULT_SETTINGS, type Thresholds } from '../../../src/site/settings.js';

const KEYS = Object.keys(DEFAULT_SETTINGS.thresholds) as (keyof Thresholds)[];

/** Throws unless the answer holds a finite number for every threshold, so a bad answer counts as a failed call. */
function assertThresholds(data: { thresholds?: Partial<Record<keyof Thresholds, unknown>> }): boolean {
  for (const k of KEYS) {
    const v = data.thresholds?.[k];
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`bad threshold ${k}`);
  }
  return false;
}

const days = (n: number) => `${n} ${n === 1 ? 'day' : 'days'}`;

/** Band edges of the shop rating, as shares of judged products (rating.ts). */
const BANDS = [
  { grade: 'A', range: 'under 5%' },
  { grade: 'B', range: '5% to under 10%' },
  { grade: 'C', range: '10% to under 20%' },
  { grade: 'D', range: '20% to under 30%' },
  { grade: 'E', range: '30% to under 45%' },
  { grade: 'F', range: '45% or more' },
] as const;

function Section({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3">
      <h2 id={id} className="text-xl font-semibold tracking-tight">
        {title}
      </h2>
      {children}
    </section>
  );
}

function List({ children }: { children: ReactNode }) {
  return <ul className="flex list-disc flex-col gap-2 pl-5 marker:text-muted-foreground">{children}</ul>;
}

export function HowWeCheckPage() {
  const state = useApi('thresholds', (signal) => api.thresholds(signal), assertThresholds);
  const t: Thresholds = state.status === 'ready' ? state.data.thresholds : DEFAULT_SETTINGS.thresholds;

  return (
    <GlassCard className="flex flex-col gap-8 p-6 leading-relaxed">
      <header className="flex flex-col gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">How we check</h1>
        <p>
          Every night we write down the prices on Maltese web shops. We then compare today&apos;s price with that history. This page
          explains how, in plain words. It is information, not legal advice.
        </p>
      </header>

      <Section title="What we record">
        <List>
          <li>
            Every night we read the product pages of about 50 Maltese web shops. Popular products are read several times a day.
          </li>
          <li>We only read public pages that anyone can open.</li>
          <li>
            For each product we save the price, the &quot;was&quot; price (the old price shown crossed out), whether it is in stock and
            whether the shop marks it as Black Friday.
          </li>
          <li>Prices are stored per day. Verdicts use the last price we saw on each day.</li>
          <li>We started on 20 October 2026. We have no earlier history, so we can only judge what happened since then.</li>
        </List>
      </Section>

      <Section title="The EU 30-day lowest price rule">
        <p>
          When a shop announces a price reduction in the EU, the price it compares with must be the lowest price it charged in the 30
          days before the reduction. This is in the Price Indication Directive (Article 6a), added by the Omnibus Directive.
        </p>
        <p>
          We do not decide whether a shop followed the rule. We cannot see a shop&apos;s own records. We show the prices we saw, with
          dates, and you can judge. Again, this is not legal advice.
        </p>
      </Section>

      <Section title="Good Deal and Deal to Avoid">
        <p>
          We only judge a product when the shop marks it as Black Friday, or shows a was price higher than the price. Other products get
          no verdict. We also need at least <strong>{days(t.minHistoryDays)}</strong> of history. Before that, the product says &quot;Not
          enough history yet&quot;. If a shop does not show a price, we say &quot;Price not shown by the shop&quot;.
        </p>
        <p>
          <strong>Lowest recent price.</strong> We look at up to <strong>{days(t.baselineDays)}</strong> before the current price (and
          was price) appeared, and take the lowest price in that time. If we have no earlier prices, we use the prices since the current price appeared.
        </p>
        <h3 className="font-semibold">Good Deal</h3>
        <List>
          <li>
            The price is <strong>at least {t.goodDropPct}%</strong> below that lowest recent price.
          </li>
          <li>
            And the was price has not gone up by <strong>more than {t.raisePct}%</strong> in the last {days(t.baselineDays)}.
          </li>
        </List>
        <h3 className="font-semibold">Deal to Avoid</h3>
        <p>Any one of these is enough:</p>
        <List>
          <li>
            The price is <strong>more than {t.raisePct}%</strong> higher than it was {days(t.raiseWindowDays)} ago (or at the start of
            our history, if that is more recent).
          </li>
          <li>
            The was price is <strong>more than {t.raisePct}%</strong> higher than it was {days(t.raiseWindowDays)} ago, measured the same
            way.
          </li>
          <li>The was price is higher than every price the shop charged in the last {days(t.baselineDays)}.</li>
        </List>
        <p>
          A product that meets any Deal to Avoid test is never a Good Deal, even if its price is low. A judged product that is neither
          gets no Good Deal or Deal to Avoid tag.
        </p>
        <p>
          The sentences we write for a Good Deal or a Deal to Avoid state prices and dates, for example &quot;€709 on 20 Oct, €799 on
          22 Oct&quot;. We do not say why a shop did it.
        </p>
        <p>
          The numbers on this page are the current settings. They can change. Verdicts and shop ratings use a change after the next
          nightly update. &quot;Cheaper at&quot; uses it within about 10 minutes.
        </p>
      </Section>

      <Section title="Shop ratings">
        <List>
          <li>A rating goes from A (best) to F. It is based on the products we judged at that shop: those marked Black Friday or showing a was price higher than the price.</li>
          <li>
            Each Deal to Avoid counts as one. If its was price was raised as well, that adds another half. We divide the total by the
            number of judged products (Good Deals plus Deals to Avoid).
          </li>
          <li>
            The share decides the letter:{' '}
            {BANDS.map((b, i) => (
              <span key={b.grade}>
                {i > 0 && ', '}
                <strong>{b.grade}</strong> {b.range}
              </span>
            ))}
            .
          </li>
          <li>
            Only shops with <strong>at least {t.minJudgedForRating} judged products</strong> get a letter. The others show &quot;Not
            rated yet&quot;.
          </li>
          <li>Ratings are worked out again every night, so a shop&apos;s letter can change from one day to the next.</li>
        </List>
      </Section>

      <Section title="The same product at other shops">
        <List>
          <li>The same barcode (GTIN) means the same product.</li>
          <li>
            The same maker part number also means the same product, when the two shop titles share a brand or model word. Placeholder
            and very short part numbers are ignored.
          </li>
          <li>
            If only the titles look alike, we call it &quot;possibly the same product&quot;. Titles must agree on model numbers, sizes
            and words like Pro or Max. Colours and filler words are ignored.
          </li>
        </List>
        <p>
          &quot;Cheaper at&quot; is shown only for the same product by barcode or part number, or a title match we have checked by hand.
          The other shop must not be known to be out of stock, and its price must be <strong>at least {t.cheaperPct}%</strong> lower. A &quot;possibly
          the same product&quot; is never used for it.
        </p>
      </Section>

      <Section title="Found a mistake?">
        <List>
          <li>
            Press <strong>Something wrong?</strong> on a deal, a shop rating or a match. Anyone can use it, including shops.
          </li>
          <li>Choose what is wrong and add a short note. An email address is optional, for a reply.</li>
          <li>
            We read every report. Depending on what we find, we fix the data, hide a shop, or confirm or reject a title match. The verdict stays visible while we look at it.
          </li>
        </List>
      </Section>
    </GlassCard>
  );
}
