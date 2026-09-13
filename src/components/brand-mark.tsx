/**
 * The dbportal symbol (docs/DESIGN.md §Logo), inline so it paints with the surface it sits
 * on: the portal frame and the two lower rows take `currentColor`, and the keyed row - the
 * statement that gets attributed - takes the brand blue. The construction is the one
 * `public/brand/symbol.svg` was generated from; only the colours are bound here.
 *
 * `strokeWidth` exists for one reason the design system states: at 20px the frame goes to
 * 4 for optical weight. Every larger use keeps the 3.5 the mark is drawn with.
 */
export function BrandMark({ className, strokeWidth = 3.5 }: { className?: string; strokeWidth?: number }) {
  return (
    <svg viewBox="0 0 48 48" fill="none" aria-hidden="true" className={className}>
      <path
        d="M4 15V7a3 3 0 0 1 3-3h8M44 15V7a3 3 0 0 0-3-3h-8M4 33v8a3 3 0 0 0 3 3h8M44 33v8a3 3 0 0 1-3 3h-8"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="square"
      />
      <rect x="13" y="14" width="22" height="5" rx="1" className="fill-brand" />
      <rect x="13" y="21.5" width="22" height="5" rx="1" fill="currentColor" />
      <rect x="13" y="29" width="13" height="5" rx="1" fill="currentColor" />
    </svg>
  );
}

/**
 * The wordmark next to the symbol. Always lowercase mono (docs/DESIGN.md §Logo rules); the
 * caller sets the size, this fixes the face, weight and tracking so no surface can drift.
 */
export function Wordmark({ className }: { className?: string }) {
  return <span className={`font-mono font-semibold tracking-[-0.03em] ${className ?? ""}`}>dbportal</span>;
}
