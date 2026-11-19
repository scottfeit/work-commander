import { useState } from 'react';
import type { UsageCategory, UsageKind, UsageTotals } from '@wc/shared';
import { USAGE_CATEGORIES, usageCategoryOf } from '@wc/shared';

/** Usage by category, in the fixed category order (which is also the colour order: .c-<id> in styles.css). */
export function byCategory(byKind: Partial<Record<UsageKind, UsageTotals>>): { id: UsageCategory; label: string; hint: string; t: UsageTotals }[] {
  const out = new Map<UsageCategory, UsageTotals>();
  for (const [k, t] of Object.entries(byKind) as [UsageKind, UsageTotals][]) {
    const c = usageCategoryOf(k);
    const cur = out.get(c);
    out.set(
      c,
      cur
        ? {
            calls: cur.calls + t.calls,
            inputTokens: cur.inputTokens + t.inputTokens,
            outputTokens: cur.outputTokens + t.outputTokens,
            cacheReadTokens: cur.cacheReadTokens + t.cacheReadTokens,
            cacheWriteTokens: cur.cacheWriteTokens + t.cacheWriteTokens,
            costUsd: cur.costUsd + t.costUsd,
          }
        : t,
    );
  }
  return USAGE_CATEGORIES.filter((c) => out.has(c.id)).map((c) => ({ id: c.id, label: c.label, hint: c.hint, t: out.get(c.id)! }));
}

export const dollars = (n: number) => (n === 0 ? '$0' : n < 0.01 ? '<$0.01' : `$${n.toFixed(2)}`);

/**
 * A work stream's estimated Claude cost, split by category: a pie with a gap between slices, and a legend that names each
 * slice with its amount and share (so no slice is told apart by colour alone). Hovering a slice or its legend row highlights both.
 */
export function UsagePie({ parts }: { parts: { id: UsageCategory; label: string; hint: string; t: UsageTotals }[] }) {
  const [hot, setHot] = useState<UsageCategory | null>(null);
  const shown = parts.filter((p) => p.t.costUsd > 0);
  const total = shown.reduce((a, p) => a + p.t.costUsd, 0);
  if (!total) return <p className="muted small">No Claude usage for this work stream yet.</p>;
  const R = 52;
  const C = 60;
  let a0 = -Math.PI / 2;
  const slices = shown.map((p) => {
    const a1 = a0 + (2 * Math.PI * p.t.costUsd) / total;
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const d =
      shown.length === 1
        ? null
        : `M${C},${C} L${C + R * Math.cos(a0)},${C + R * Math.sin(a0)} A${R},${R} 0 ${large} 1 ${C + R * Math.cos(a1)},${C + R * Math.sin(a1)} Z`;
    const s = { p, d };
    a0 = a1;
    return s;
  });
  const pct = (n: number) => `${Math.round((100 * n) / total)}%`;
  return (
    <div className="usage-pie">
      <svg viewBox="0 0 120 120" width="132" height="132" role="img" aria-label={`Estimated cost ${dollars(total)}: ${shown.map((p) => `${p.label} ${dollars(p.t.costUsd)}`).join(', ')}`}>
        <defs>
          <pattern id="usage-hatch-claudeCode" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect className="usage-hatch-bg" width="5" height="5" />
            <line className="usage-hatch-fg" x1="1.5" y1="0" x2="1.5" y2="5" />
          </pattern>
        </defs>
        {slices.map(({ p, d }) =>
          d ? (
            <path key={p.id} d={d} className={`c-${p.id} ${hot && hot !== p.id ? 'dim' : ''}`} onMouseEnter={() => setHot(p.id)} onMouseLeave={() => setHot(null)}>
              <title>{`${p.label}: ${dollars(p.t.costUsd)} (${pct(p.t.costUsd)}), ${p.t.calls} call${p.t.calls === 1 ? '' : 's'}`}</title>
            </path>
          ) : (
            <circle key={p.id} cx={C} cy={C} r={R} className={`c-${p.id}`}>
              <title>{`${p.label}: ${dollars(p.t.costUsd)} (100%)`}</title>
            </circle>
          ),
        )}
      </svg>
      <table className="usage-pie-legend">
        <caption className="sr-only">Estimated cost by category</caption>
        <tbody>
          {shown.map((p) => (
            <tr key={p.id} className={hot === p.id ? 'hot' : ''} onMouseEnter={() => setHot(p.id)} onMouseLeave={() => setHot(null)} title={p.hint}>
              <td>
                <i className={`swatch c-${p.id}`} aria-hidden />
                {p.label}
              </td>
              <td className="usage-num">{dollars(p.t.costUsd)}</td>
              <td className="usage-num muted">{pct(p.t.costUsd)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td>Total (estimated)</td>
            <td className="usage-num">{dollars(total)}</td>
            <td />
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
