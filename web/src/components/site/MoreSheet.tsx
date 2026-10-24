import { ChevronRight, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { ModeSwitch, ThemeChoice } from '@/components/site/Preferences';
import { HOW_WE_CHECK } from '@/components/site/nav';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';

/**
 * The bottom bar's More menu, a modal bottom sheet: focus is trapped inside, Escape closes it and focus goes back
 * to `trigger` (the More button). Links, the Advanced mode switch and the System / Light / Dark choice.
 */
export function MoreSheet({ trigger }: { trigger: ReactNode }) {
  return (
    <Sheet>
      <SheetTrigger asChild>{trigger}</SheetTrigger>
      <SheetContent
        side="bottom"
        showCloseButton={false}
        className="gap-3.5 rounded-t-3xl border-0 bg-surface px-5 pt-4 pb-[calc(1.75rem+env(safe-area-inset-bottom))] text-ink shadow-[0_-12px_40px_-12px_rgba(0,0,0,0.4)]"
      >
        <SheetHeader className="flex-row items-center justify-between p-0">
          <SheetTitle className="text-xl font-bold">More</SheetTitle>
          <SheetDescription className="sr-only">Pages and display settings</SheetDescription>
          <SheetClose asChild>
            <Button variant="outline" size="icon" aria-label="Close">
              <X aria-hidden="true" className="size-[18px]" />
            </Button>
          </SheetClose>
        </SheetHeader>
        <ul className="m-0 list-none p-0">
          <li>
            <SheetClose asChild>
              <Link
                to={HOW_WE_CHECK.to}
                className="flex min-h-12 items-center justify-between border-b border-line font-semibold text-ink outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                {HOW_WE_CHECK.label}
                <ChevronRight aria-hidden="true" className="size-4 text-faint" />
              </Link>
            </SheetClose>
          </li>
        </ul>
        <ModeSwitch />
        <div className="flex flex-col gap-2">
          <p aria-hidden="true" className="font-semibold">
            Theme
          </p>
          <ThemeChoice />
        </div>
      </SheetContent>
    </Sheet>
  );
}
