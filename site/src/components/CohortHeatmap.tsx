import type { CohortRetentionRow, PlanMixRow } from "../lib/metricsEngine";
import { formatPlanLabel } from "../lib/format";

interface CohortHeatmapProps {
  rows: CohortRetentionRow[];
  /** Optional — when passed, each plan's triangle gets a footer tying its
   * cells back to the same cancelled/pending counts shown in the "Plan
   * comparison" table below, so the two don't look like disconnected
   * numbers. */
  planMix?: PlanMixRow[];
}

/**
 * One retention triangle per plan (monthly/bimonthly/trimonthly have very
 * different renewal cadences, so pooling them into one table made the
 * columns mean different things row to row). Cohort month × renewal cycle,
 * cell = % of that cohort's *resolved* outcomes that renewed (see
 * maturedByCycle in metricsEngine.ts) — cycles nobody in that cohort has
 * actually reached yet render as "aguardando" rather than a misleading 0%.
 */
export function CohortHeatmap({ rows, planMix }: CohortHeatmapProps) {
  if (rows.length === 0) {
    return <p className="text-sm text-gray-400">Not enough billing history yet to build a retention curve.</p>;
  }

  const byPlan = new Map<string, CohortRetentionRow[]>();
  for (const row of rows) {
    const arr = byPlan.get(row.plan) ?? [];
    arr.push(row);
    byPlan.set(row.plan, arr);
  }
  const planMixByPlan = new Map((planMix ?? []).map((p) => [p.plan, p]));

  return (
    <div className="space-y-8">
      {[...byPlan.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([plan, planRows]) => (
        <PlanTriangle key={plan} plan={plan} rows={planRows} mix={planMixByPlan.get(plan)} />
      ))}
    </div>
  );
}

function PlanTriangle({ plan, rows, mix }: { plan: string; rows: CohortRetentionRow[]; mix?: PlanMixRow }) {
  const maxCycle = Math.max(1, ...rows.map((r) => Math.max(0, ...Object.keys(r.retentionByCyclePct).map(Number))));
  const cycles = Array.from({ length: maxCycle }, (_, i) => i + 1);

  return (
    <div>
      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">{formatPlanLabel(plan)}</p>
      <div className="overflow-x-auto">
        <table className="min-w-full border-collapse text-xs">
          <thead>
            <tr>
              <th className="sticky left-0 bg-white px-2 py-2 text-left font-medium text-gray-500">Cohort</th>
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
              <tr key={row.cohortMonth} className="border-t border-gray-100">
                <td className="sticky left-0 bg-white px-2 py-2 font-medium text-gray-900">{row.cohortMonth}</td>
                <td className="px-2 py-2 text-right text-gray-600">{row.cohortSize}</td>
                {cycles.map((c) => {
                  const pct = row.retentionByCyclePct[c];
                  const matured = row.maturedByCycle[c];
                  if (pct === undefined || matured === undefined) {
                    return (
                      <td
                        key={c}
                        className="px-2 py-2 text-center text-gray-300"
                        title="Ninguém deste cohort venceu esta renovação ainda"
                      >
                        aguardando
                      </td>
                    );
                  }
                  const reached = row.reachedByCycle[c];
                  return (
                    <td
                      key={c}
                      className="px-2 py-2 text-center text-gray-900"
                      style={{ backgroundColor: `rgba(206, 32, 47, ${Math.max(pct / 100, 0.06)})` }}
                      title={`${matured} de ${row.cohortSize} já venceram esta renovação (os outros ${row.cohortSize - matured} ainda estão dentro da janela de graça)`}
                    >
                      <div>{`${pct.toFixed(0)}%`}</div>
                      <div className="text-[10px] font-normal text-gray-400">{`${reached}/${matured}`}</div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {mix && (
        <p className="mt-2 text-[11px] text-gray-400">
          {mix.cancelledSubscribers} cancelados no total desse plano · {mix.pendingSubscribers} ainda dentro da janela
          de graça (pending) · {mix.activeSubscribers} ativos — ver "Plan comparison" abaixo.
        </p>
      )}
    </div>
  );
}
