import { Link } from 'react-router';
import { GlassCard } from '@/components/site/GlassCard';

export function NotFoundPage() {
  return (
    <GlassCard className="p-6">
      <h1 className="text-2xl font-semibold tracking-tight">Page not found</h1>
      <p className="mt-2 text-muted-foreground">
        That page does not exist.{' '}
        <Link to="/" className="text-brand underline underline-offset-4">
          Back to the home page
        </Link>
      </p>
    </GlassCard>
  );
}
