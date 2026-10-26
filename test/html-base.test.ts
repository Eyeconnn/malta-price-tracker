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

describe('tile pictures', () => {
  // Eurosport (nopCommerce): a 1px data: placeholder in src, the real address in data-lazyloadsrc, and a hover
  // picture before the main one
  const tile = cheerio.load(`<div class="item-box"><div class="product-item">
    <img class="second-product-image" src="data:image/gif;base64,R0lGOD" data-lazyloadsrc="https://eurosport.com.mt/images/thumbs/1_hover.jpeg">
    <img class="product-image" src="data:image/gif;base64,R0lGOD" data-lazyloadsrc="https://eurosport.com.mt/images/thumbs/1_main.png">
    <h2 class="product-title"><a href="/leather-workbag">Leather Workbag</a></h2>
    <span class="price">€59.00</span>
  </div></div>`);
  const page = 'https://www.eurosport.com.mt/men?pagesize=72&pagenumber=1';
  const euro = { tile: 'div.item-box .product-item', link: '.product-title a', price: '.price' } as never;

  it('reads a lazy-loaded address and never the data: placeholder', () => {
    const [r] = parseTiles(tile, page, euro);
    expect(r!.image_url).toBe('https://eurosport.com.mt/images/thumbs/1_hover.jpeg');
  });

  it('takes the main picture when the config names it', () => {
    const [r] = parseTiles(tile, page, { ...(euro as object), image: 'img.product-image' } as never);
    expect(r!.image_url).toBe('https://eurosport.com.mt/images/thumbs/1_main.png');
  });

  it('has no picture when only a placeholder is there', () => {
    const $ = cheerio.load('<div class="t"><a href="/x">X</a><img src="data:image/gif;base64,R0lGOD"></div>');
    const [r] = parseTiles($, page, { tile: 'div.t', link: 'a' } as never);
    expect(r!.image_url).toBeNull();
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
