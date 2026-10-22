import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

/** A frosted glass card floating over the dotted background. */
export function GlassCard({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('glass', className)} {...props} />;
}
