import { Tag } from 'lucide-react';
import { Link } from 'react-router';

/**
 * The brand (an accent square with a price tag, then the name) as a link home, white on the smoked bars. It is
 * deliberately not a heading: each page renders its own h1.
 */
export function SiteLogo() {
  return (
    <Link
      to="/"
      className="inline-flex min-h-11 items-center gap-2.5 rounded-lg font-bold whitespace-nowrap text-white outline-none hover:text-white focus-visible:ring-[3px] focus-visible:ring-white/70"
    >
      <span aria-hidden="true" className="inline-flex size-[30px] items-center justify-center rounded-lg bg-brand text-primary-foreground">
        <Tag className="size-[18px]" strokeWidth={2} />
      </span>
      Black Friday Guide
    </Link>
  );
}
