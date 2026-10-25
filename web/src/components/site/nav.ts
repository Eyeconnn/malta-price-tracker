/** Where the Deals and Shops links go; shared by the top nav and the bottom bar. Search is not a link: it opens the search overlay. */
export const MAIN_LINKS = [
  { to: '/deals', label: 'Deals' },
  { to: '/shops', label: 'Shops' },
] as const;

export const HOW_WE_CHECK = { to: '/how-we-check', label: 'How we check' } as const;

/** Tailwind min-width breakpoint (md) where the top nav takes over from the bottom bar. */
export const DESKTOP_QUERY = '(min-width: 768px)';

/** Search counts as the current page on the home page (the big search) and the results page. */
export const isSearchPage = (path: string) => path === '/' || path === '/search';
