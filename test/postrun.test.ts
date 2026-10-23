// afterRun hands the scrape run's own fetcher to the image step, so the first image request keeps the run's gap
// and Crawl-delay instead of following the scrape's last request at once.
import { describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({ images: [] as unknown[][] }));
vi.mock('../src/pipeline/tiers.js', () => ({ updateTiers: vi.fn(async () => {}) }));
vi.mock('../src/pipeline/alerts.js', () => ({ checkRun: vi.fn(async () => []) }));
vi.mock('../src/pipeline/store.js', () => ({ closeStaleRuns: vi.fn(async () => []) }));
vi.mock('../src/email.js', () => ({ sendEmail: vi.fn(async () => {}) }));
vi.mock('../src/pipeline/images.js', () => ({
  downloadImagesForShop: vi.fn(async (...args: unknown[]) => {
    calls.images.push(args);
    return { downloaded: 0, linked: 0 };
  }),
}));

const { afterRun } = await import('../src/pipeline/postRun.js');
const { ShopFetcher } = await import('../src/http/fetcher.js');

describe('afterRun', () => {
  it("passes the run's fetcher to the image step", async () => {
    const fetcher = new ShopFetcher({ userAgent: 'TestBot/1.0' });
    const shop = { id: 1, slug: 'alpha' };
    await afterRun({ shop, runId: 5, totals: { products_seen: 10 }, durationMs: 1000, fetcher } as never, { images: true });
    expect(calls.images).toHaveLength(1);
    expect(calls.images[0][0]).toBe(shop);
    expect((calls.images[0][1] as { shopFetcher: unknown }).shopFetcher).toBe(fetcher);
  });
});
