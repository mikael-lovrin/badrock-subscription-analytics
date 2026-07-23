import type { CohortRetentionRow } from "../lib/metricsEngine";
import { formatPlanLabel } from "../lib/format";

interface CohortHeatmapProps {
  rows: CohortRetentionRow[];
}

/**
 * Retention-by-renewal-cycle % as a heatmap: one row per (cohort month,
 * plan), one column per renewal cycle (cycle 1 = the first renewal, NOT
 * the initial purchase — see metricsEngine.ts's Contract.renewalsReached).
 * Cell shading is a straight linear interpolation between light and full
 * brand-red at 0-100% retention — darker cell = more of that cohort still
 * renewing at that cycle.
 */
export function CohortHeatmap({ rows }: CohortHeatmapProps) {
  if (rows.length === 0) {
    return <p className="text-sm text-gray-400">Not enough billing history yet to build a retention curve.</p>;
  }

  const maxCycle = Math.max(...rows.map((r) => Math.max(0, ...Object.keys(r.retentionByCyclePct).map(Number))));
  const cycles = Array.from({ length: maxCycle }, (_, i) => i + 1);

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full border-collapse text-xs">
        <thead>
          <tr>
            <th className="sticky left-0 bg-white px-2 py-2 text-left font-medium text-gray-500">Cohort</th>
            <th className="px-2 py-2 text-left font-medium text-gray-500">Plan</th>
            <th className="px-2 py-2 text-right font-medium text-gray-500">Size</th>
            {cycles.map((c) => (
              <th key={c} className="px-2 py-2 text-center font-medium text-gray-500">
                Renewal {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={`${row.cohortMonth}-${row.plan}`} className="border-t border-gray-100">
              <td className="sticky left-0 bg-white px-2 py-2 font-medium text-gray-900">{row.cohortMonth}</td>
              <td className="px-2 py-2 text-gray-600">{formatPlanLabel(row.plan)}</td>
              <td className="px-2 py-2 text-right text-gray-600">{row.cohortSize}</td>
              {cycles.map((c) => {
                const pct = row.retentionByCyclePct[c];
                return (
                  <td
                    key={c}
                    className="px-2 py-2 text-center text-gray-900"
                    style={pct === undefined ? undefined : { backgroundColor: `rgba(206, 32, 47, ${Math.max(pct / 100, 0.06)})` }}
                  >
                    {pct === undefined ? "—" : `${pct.toFixed(0)}%`}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
