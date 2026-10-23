// @vitest-environment jsdom
// ProductImage: our own photo copies only, sized against layout shift, lazy, with the clean name as alt text.
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ProductImage } from '@/components/site/ProductResult';

afterEach(cleanup);

const PHOTO = `/img/${'a'.repeat(64)}.webp`;

describe('ProductImage', () => {
  it('renders our photo with width, height, lazy loading, async decoding and the clean name as alt', () => {
    const { container } = render(<ProductImage url={PHOTO} name="Samsung Galaxy S25 Ultra Smartphone" size={64} className="size-16" />);
    const img = container.querySelector('img')!;
    expect(img.getAttribute('src')).toBe(PHOTO);
    expect(img.getAttribute('width')).toBe('64');
    expect(img.getAttribute('height')).toBe('64');
    expect(img.getAttribute('loading')).toBe('lazy');
    expect(img.getAttribute('decoding')).toBe('async');
    expect(img.getAttribute('alt')).toBe('Samsung Galaxy S25 Ultra Smartphone');
    expect(img.className).toContain('object-contain');
  });

  it('shows a neutral placeholder of the same size when there is no photo', () => {
    const { container } = render(<ProductImage url={null} name="Kettle" size={40} className="size-10" />);
    expect(container.querySelector('img')).toBeNull();
    const ph = container.querySelector('[data-photo-placeholder]') as HTMLElement;
    expect(ph).not.toBeNull();
    expect(ph.getAttribute('aria-hidden')).toBe('true');
    expect(ph.className).toContain('size-10');
  });

  it('never points the browser at a shop: any other address gets the placeholder', () => {
    for (const url of ['https://shop.example/p.jpg', '//shop.example/p.jpg', 'data:image/png;base64,AAAA', `/img/${'a'.repeat(64)}.png`]) {
      const { container } = render(<ProductImage url={url} name="Kettle" size={40} />);
      expect(container.querySelector('img'), url).toBeNull();
      cleanup();
    }
  });

  it('falls back to the placeholder when the photo does not load', () => {
    const { container } = render(<ProductImage url={PHOTO} name="Kettle" size={40} />);
    fireEvent.error(container.querySelector('img')!);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('[data-photo-placeholder]')).not.toBeNull();
  });
});
