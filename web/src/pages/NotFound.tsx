import { Link } from 'react-router';
import { GlassCard } from '@/components/site/GlassCard';

export function NotFoundPage() {
  return (
    <GlassCard className="flex flex-col gap-2 p-[22px] md:p-8">
      <p className="t-lbl">404</p>
      <h1 className="text-[26px] leading-tight font-bold tracking-[-0.01em] md:text-[32px]">Page not found</h1>
      <p className="text-muted-foreground">
        That page does not exist.{' '}
        <Link to="/" className="font-semibold text-brand underline underline-offset-4">
          Back to the home page
        </Link>
      </p>
    </GlassCard>
  );
}
