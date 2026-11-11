/** Animated starburst shown while Claude is working: the mark breathes (rays expand and contract together, slightly out of step) while it slowly turns. */
const RAYS = 12;
// Uneven ray lengths and small timing offsets make the burst feel organic rather than mechanical.
const LEN = [8.6, 7.2, 9.2, 6.8, 8.2, 7.6, 9, 7, 8.8, 6.6, 8.4, 7.4];
const DELAY = [0, 0.12, 0.05, 0.18, 0.08, 0.15, 0.02, 0.2, 0.1, 0.16, 0.04, 0.13];

export function ThinkingMark({ size = 22, label = 'Claude is working' }: { size?: number; label?: string }) {
  return (
    <span className="thinking-mark" role="status" aria-label={label} style={{ width: size, height: size }}>
      <svg viewBox="-12 -12 24 24" width={size} height={size} aria-hidden="true">
        {Array.from({ length: RAYS }, (_, i) => (
          <g key={i} transform={`rotate(${(360 / RAYS) * i})`}>
            <rect className="ray" x={-1.1} y={-2.4 - LEN[i]} width={2.2} height={LEN[i]} rx={1.1} style={{ animationDelay: `${-DELAY[i]}s` }} />
          </g>
        ))}
      </svg>
    </span>
  );
}
