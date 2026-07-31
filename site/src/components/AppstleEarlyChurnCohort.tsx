import type { AppstleEarlyChurnCohortRow } from "../lib/metricsEngine";
import { formatPlanLabel } from "../lib/format";

interface AppstleEarlyChurnCohortProps {
  rows: AppstleEarlyChurnCohortRow[];
}

/**
 * One small pyramid per plan: acquisition month × how many of that
 * month's real Appstle subscriptions cancelled before ever reaching their
 * first renewal. Mirrors CohortHeatmap's per-plan-triangle layout, but
 * with a single column instead of a renewal-cycle grid — this signal
 * isn't about how far someone got, just whether they bailed before their
 * first real test (the first renewal charge).
 */
export function AppstleEarlyChurnCohort({ rows }: AppstleEarlyChurnCohortProps) {
  if (rows.length === 0) {
    return <p className="text-sm text-gray-400">No Appstle data loaded.</p>;
  }

  const byPlan = new Map<string, AppstleEarlyChurnCohortRow[]>();
  for (const row of rows) {
    const arr = byPlan.get(row.plan) ?? [];
    arr.push(row);
    byPlan.set(row.plan, arr);
  }

  return (
    <div className="space-y-8">
      {[...byPlan.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([plan, planRows]) => (
        <div key={plan}>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">{formatPlanLabel(plan)}</p>
          <div className="overflow-x-auto">
            <table className="min-w-full border-collapse text-xs">
              <thead>
                <tr>
                  <th className="px-2 py-2 text-left font-medium text-gray-500">Cohort</th>
                  <th className="px-2 py-2 text-right font-medium text-gray-500">Size</th>
                  <th className="px-2 py-2 text-center font-medium text-gray-500">Cancelled before 1st renewal</th>
                </tr>
              </thead>
              <tbody>
                {planRows.map((row) => (
                  <tr key={row.cohortMonth} className="border-t border-gray-100">
                    <td className="px-2 py-2 font-medium text-gray-900">{row.cohortMonth}</td>
                    <td className="px-2 py-2 text-right text-gray-600">{row.cohortSize}</td>
                    <td
                      className="px-2 py-2 text-center text-gray-900"
                      style={{
                        backgroundColor: `rgba(206, 32, 47, ${Math.max(row.pctCancelledBeforeFirstRenewal / 100, 0.06)})`,
                      }}
                      title={`${row.cancelledBeforeFirstRenewal} de ${row.cohortSize} cancelaram antes da 1ª renovação`}
                    >
                      <div>{`${row.pctCancelledBeforeFirstRenewal.toFixed(0)}%`}</div>
                      <div className="text-[10px] font-normal text-gray-400">{`${row.cancelledBeforeFirstRenewal}/${row.cohortSize}`}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  );
}
