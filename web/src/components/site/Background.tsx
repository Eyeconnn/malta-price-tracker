/**
 * The fixed page background: a warm paper gradient, a quiet tile of product line icons and fine film grain
 * (styles: `.site-bg` in styles.css). There are no coloured glows behind content.
 */
export function Background() {
  return <div aria-hidden="true" className="site-bg" />;
}

/**
 * The refraction filter the deal cards' glass uses (`.glass-card`, only where backdrop-filter accepts an SVG
 * filter). Rendered once, by the Layout.
 */
export function GlassFilters() {
  return (
    <svg width="0" height="0" aria-hidden="true" focusable="false" className="pointer-events-none absolute">
      <filter id="bfg-refract" x="0" y="0" width="100%" height="100%" colorInterpolationFilters="sRGB">
        <feTurbulence type="fractalNoise" baseFrequency="0.006 0.011" numOctaves={2} seed={7} result="noise" />
        <feGaussianBlur in="noise" stdDeviation="2" result="soft" />
        <feDisplacementMap in="SourceGraphic" in2="soft" scale={42} xChannelSelector="R" yChannelSelector="G" />
      </filter>
    </svg>
  );
}
