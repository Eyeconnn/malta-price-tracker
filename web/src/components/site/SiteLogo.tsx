import { Link } from 'react-router';

/** The site name as a link home. It is deliberately not a heading: each page renders its own h1. */
export function SiteLogo() {
  return (
    <Link
      to="/"
      className="inline-flex min-h-11 items-center rounded-md font-bold tracking-tight text-ink outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
    >
      Black Friday <span className="ml-1 text-brand">Guide</span>
    </Link>
  );
}
