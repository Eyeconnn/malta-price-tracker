// Relative links and images on config-driven HTML shops resolve against the page's <base href> when it has one
// (Telecom sets <base href="https://www.telecom.com.mt/"> and writes image paths like "dynimage/shopimage/1/image.jpg").
import * as cheerio from 'cheerio';
import { describe, expect, it } from 'vitest';
import { documentBase, parseTiles } from '../src/adapters/html.js';

const PAGE = 'https://www.telecom.com.mt/en/shop/webshop/bycategory/30/name/asc/24/2/';
const config = {
  tile: 'div.card',
  link: '.card-title a',
  id: { url_regex: '/webshop/(\\d+)/' },
  title: '.card-title a',
  price: '.price',
} as never;

function page(head: string) {
  return cheerio.load(`<html><head>${head}</head><body>
    <div class="card">
      <h5 class="card-title"><a href="en/shop/webshop/50317/iphone.htm">iPhone</a></h5>
      <img src="dynimage/shopimage/50317/image.jpg">
      <span class="price">€999.00</span>
    </div></body></html>`);
}

describe('documentBase', () => {
  it('uses the page base href when present, resolved against the page', () => {
    expect(documentBase(page('<base href="https://www.telecom.com.mt/" />'), PAGE)).toBe('https://www.telecom.com.mt/');
    expect(documentBase(page('<base href="/shop/" />'), PAGE)).toBe('https://www.telecom.com.mt/shop/');
  });

  it('falls back to the page address without a base, or with an unusable one', () => {
    expect(documentBase(page(''), PAGE)).toBe(PAGE);
    expect(documentBase(page('<base href="javascript:alert(1)" />'), PAGE)).toBe(PAGE);
    expect(documentBase(page('<base href="https://evil.example/" />'), PAGE)).toBe(PAGE);
  });
});

describe('parseTiles with a base href', () => {
  it('resolves relative product links and images against the base', () => {
    const [r] = parseTiles(page('<base href="https://www.telecom.com.mt/" />'), PAGE, config);
    expect(r!.image_url).toBe('https://www.telecom.com.mt/dynimage/shopimage/50317/image.jpg');
    expect(r!.url).toBe('https://www.telecom.com.mt/en/shop/webshop/50317/iphone.htm');
  });

  it('still resolves against the page address when there is no base', () => {
    const [r] = parseTiles(page(''), PAGE, config);
    expect(r!.image_url).toBe(`${PAGE}dynimage/shopimage/50317/image.jpg`);
  });
});
