import { X } from 'lucide-react';
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
 * The bottom bar's More menu, a modal dialog: focus is trapped inside, Escape closes it and focus
 * goes back to `trigger` (the More button). Later plans add hall of shame, price watches and
 * basket check here.
 */
export function MoreSheet({ trigger }: { trigger: ReactNode }) {
  return (
    <Sheet>
      <SheetTrigger asChild>{trigger}</SheetTrigger>
      <SheetContent
        side="bottom"
        showCloseButton={false}
        className="rounded-t-2xl px-4 pb-[calc(1rem+env(safe-area-inset-bottom))]"
      >
        <SheetHeader className="flex-row items-center justify-between p-0 pt-2">
          <SheetTitle className="text-lg">More</SheetTitle>
          <SheetDescription className="sr-only">Pages and display settings</SheetDescription>
          <SheetClose asChild>
            <Button variant="ghost" className="size-11" aria-label="Close">
              <X aria-hidden="true" className="size-5" />
            </Button>
          </SheetClose>
        </SheetHeader>
        <ul className="m-0 list-none p-0">
          <li>
            <SheetClose asChild>
              <Link
                to={HOW_WE_CHECK.to}
                className="flex min-h-11 items-center rounded-md text-sm font-medium outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                {HOW_WE_CHECK.label}
              </Link>
            </SheetClose>
          </li>
        </ul>
        <ModeSwitch />
        <div>
          <p aria-hidden="true" className="mb-2 text-sm font-medium">
            Theme
          </p>
          <ThemeChoice />
        </div>
      </SheetContent>
    </Sheet>
  );
}
