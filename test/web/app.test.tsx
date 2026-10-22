// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '@/App';

afterEach(cleanup);

describe('App', () => {
  it('renders the site title on a glass card', () => {
    render(<App />);
    const heading = screen.getByRole('heading', { name: 'Black Friday Guide' });
    expect(heading.closest('.glass')).not.toBeNull();
  });
});
