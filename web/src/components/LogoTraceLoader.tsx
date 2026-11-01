import { useCallback, useEffect, useRef, useState } from 'react';

type LoaderPhase = 'loop' | 'closingOutline' | 'fadingFill' | 'done';

type Props = {
  /** While true (and not complete) a short segment keeps tracing the logo. */
  loading?: boolean;
  /** Resolves the loader into the filled logo, same as `loading` turning false. */
  isComplete?: boolean;
  size?: number;
  /** Width of the moving trace segment, in logo units. */
  strokeWidth?: number;
  loopDurationSeconds?: number;
  fillFadeSeconds?: number;
  className?: string;
  ariaLabel?: string;
  /** Called once, after the filled logo is visible. */
  onDone?: () => void;
};

// The Azhi Flow glyph (docs/brand/glyph.svg, web/src/brand.tsx): ழ drawn as one open line.
const LOGO_VIEW_BOX = '0 0 64 64';
const TRACE_PATH =
  'M16 13 V36 H39.5 C44.5 36 48.5 31.5 48.5 24.5 C48.5 17.5 44.5 13 39.5 13 C34.5 13 30.5 17.5 30.5 24.5 V45 C30.5 49.5 27.5 52 24 52 C20.5 52 18.5 49.8 18.5 47.5';
// The logo has no filled shapes: the mark is the same line at its native weight, so the resolved
// state is that line stroked at LOGO_STROKE_WIDTH instead of a filled outline.
const FILL_PATHS = [TRACE_PATH] as const;
const LOGO_STROKE_WIDTH = 6.5;

const CLOSE_OUTLINE_SECONDS = 0.6;

function prefersReducedMotion() {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Traces the logo while work is in progress, then closes the outline and fades in the full mark.
 * Colours come from `currentColor`. Each phase advances on its animation's end event and on a timer,
 * so a missed event never strands the loader. Reduced motion shows the mark at once.
 */
export function LogoTraceLoader({
  loading = true,
  isComplete = false,
  size = 48,
  strokeWidth = LOGO_STROKE_WIDTH,
  loopDurationSeconds = 1.4,
  fillFadeSeconds = 0.4,
  className,
  ariaLabel = 'Loading',
  onDone,
}: Props) {
  const [phase, setPhase] = useState<LoaderPhase>(() => (prefersReducedMotion() ? 'done' : 'loop'));
  const onDoneRef = useRef(onDone);
  const doneCalledRef = useRef(false);
  onDoneRef.current = onDone;

  const advance = useCallback((from: LoaderPhase, to: LoaderPhase) => setPhase((current) => (current === from ? to : current)), []);

  useEffect(() => {
    if ((isComplete || !loading) && phase === 'loop') setPhase('closingOutline');
  }, [isComplete, loading, phase]);

  useEffect(() => {
    if (phase === 'closingOutline') {
      const timer = window.setTimeout(() => advance('closingOutline', 'fadingFill'), CLOSE_OUTLINE_SECONDS * 1000 + 50);
      return () => window.clearTimeout(timer);
    }
    if (phase === 'fadingFill') {
      const timer = window.setTimeout(() => advance('fadingFill', 'done'), fillFadeSeconds * 1000 + 50);
      return () => window.clearTimeout(timer);
    }
    if (phase === 'done' && !doneCalledRef.current) {
      doneCalledRef.current = true;
      onDoneRef.current?.();
    }
  }, [phase, fillFadeSeconds, advance]);

  return (
    <svg role="status" aria-label={ariaLabel} viewBox={LOGO_VIEW_BOX} width={size} height={size} className={className}>
      {phase !== 'done' ? (
        <g opacity="0.18">
          <path d={TRACE_PATH} fill="none" stroke="currentColor" strokeWidth={Math.max(1, strokeWidth / 2)} strokeLinecap="round" strokeLinejoin="round" />
        </g>
      ) : null}

      {phase === 'loop' ? (
        <path
          d={TRACE_PATH}
          fill="none"
          stroke="currentColor"
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeLinejoin="round"
          pathLength={1}
          strokeDasharray="0.16 0.84"
          style={{ animation: `logo-trace-loader-loop ${loopDurationSeconds}s linear infinite` }}
        />
      ) : null}

      {phase === 'closingOutline' || phase === 'fadingFill' ? (
        <path
          d={TRACE_PATH}
          fill="none"
          stroke="currentColor"
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeLinejoin="round"
          pathLength={1}
          strokeDasharray="1 1"
          style={{ animation: `logo-trace-loader-close ${CLOSE_OUTLINE_SECONDS}s ease-out both` }}
          onAnimationEnd={() => advance('closingOutline', 'fadingFill')}
        />
      ) : null}

      {phase === 'fadingFill' || phase === 'done' ? (
        <g
          style={phase === 'done' && prefersReducedMotion() ? undefined : { animation: `logo-trace-loader-fill ${fillFadeSeconds}s ease-out both` }}
          onAnimationEnd={() => advance('fadingFill', 'done')}
        >
          {FILL_PATHS.map((path) => (
            <path key={path} d={path} fill="none" stroke="currentColor" strokeWidth={LOGO_STROKE_WIDTH} strokeLinecap="round" strokeLinejoin="round" />
          ))}
        </g>
      ) : null}
    </svg>
  );
}
