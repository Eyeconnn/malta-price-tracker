import type { Grade } from '../../../../src/site/rating.js';
import { cn } from '@/lib/utils';

const LETTERS: readonly Grade[] = ['A', 'B', 'C', 'D', 'E', 'F'];
/** Letter size in px by distance from the shop's grade (index 0 is the grade itself). */
const SIZES = [54, 30, 24, 19, 15, 12] as const;
const UNRATED_SIZE = 15;

export type RatingScaleProps = { grade: Grade | null; sentence: string; className?: string };

/**
 * The RATING ruler: letters A to F over ticks and a green-to-red band. The shop's grade is the
 * largest letter with a pointer under it, the others shrink with distance. With no grade every
 * letter is small and grey and "Not rated yet" is shown, so nothing reads as an F.
 * The ruler is decorative for screen readers; the grade and sentence are stated as text.
 */
export function RatingScale({ grade, sentence, className }: RatingScaleProps) {
  const at = grade === null ? -1 : LETTERS.indexOf(grade);
  return (
    <div className={cn('rating', className)} data-grade={grade ?? 'none'}>
      <div aria-hidden="true">
        <div className="rating-label">RATING</div>
        <div className="rating-ruler">
          <div className="rating-letters">
            {LETTERS.map((letter, i) => {
              const distance = at < 0 ? null : Math.abs(i - at);
              return (
                <span
                  key={letter}
                  data-letter={letter}
                  data-on={String(distance === 0)}
                  className="rating-letter"
                  style={{
                    fontSize: `${distance === null ? UNRATED_SIZE : SIZES[distance]}px`,
                    color: distance === null ? 'var(--muted)' : `var(--grade-${letter.toLowerCase()})`,
                    opacity: distance === null ? 0.75 : 1 - distance * 0.08,
                  }}
                >
                  {letter}
                </span>
              );
            })}
          </div>
          <div className="rating-ticks" />
          <div className="rating-band" />
        </div>
      </div>
      {grade === null && (
        <p className="rating-none">
          <span className="sr-only">Rating: </span>
          <span>Not rated yet</span>
        </p>
      )}
      <p className="mt-3 text-[13.5px]">
        {grade !== null && <span className="sr-only">Rating {grade}: </span>}
        {sentence}
      </p>
    </div>
  );
}
