import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

/**
 * A frosted glass panel over the page texture (`glass`), or with `variant="card"` the thicker deal card glass
 * with grain and refraction (`glass-card`). Cards never get a coloured glow.
 */
export function GlassCard({ className, variant = 'panel', ...props }: ComponentProps<'div'> & { variant?: 'panel' | 'card' }) {
  return <div className={cn(variant === 'card' ? 'glass-card' : 'glass', className)} {...props} />;
}
