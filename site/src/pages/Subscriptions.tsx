import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Card } from "../components/Card";
import { CohortHeatmap } from "../components/CohortHeatmap";
import { DataBoundary } from "../components/DataBoundary";
import { KpiCard } from "../components/KpiCard";
import { PageHeader } from "../components/PageHeader";
import { formatCurrency, formatNumber, formatPercent, formatPlanLabel } from "../lib/format";
import { useJson } from "../lib/useJson";
import type { SubscriptionsData } from "../lib/types";

const CHART_TICK_STYLE = { fontSize: 11, fill: "#6b7280" };

export function Subscriptions() {
  const state = useJson<SubscriptionsData>("subscriptions.json");

  return (
    <DataBoundary state={state}>
      {(data, generatedAt) => (
        <div>
          <PageHeader
            title="Subscriptions"
            description="MRR, renewal-cycle churn, cohort retention and LTV — sourced from Appstle's billing ledger, not order history."
            generatedAt={generatedAt}
          />

          <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
            <KpiCard label="MRR" value={formatCurrency(data.mrr.total_mrr)} hint={`${data.mrr.total_active_subscribers} active subscribers`} />
            <KpiCard
              label="Avg LTV (to date)"
              value={formatCurrency(data.ltv.overall_avg_ltv)}
              hint="Rises until the full cohort has churned"
            />
            <KpiCard
              label="Avg subscriber lifespan"
              value={
                data.average_lifespan.avg_lifespan_days !== null
                  ? `${Math.round(data.average_lifespan.avg_lifespan_days)} days`
                  : "—"
              }
              hint={`Based on ${data.average_lifespan.sample_size} churned subscriber(s)`}
            />
            <KpiCard
              label="Cancellation rate"
              value={formatPercent(
                data.plan_mix.reduce((sum, p) => sum + p.cancelled_subscribers, 0) /
                  Math.max(1, data.plan_mix.reduce((sum, p) => sum + p.total_subscribers, 0)) *
                  100,
              )}
              hint="Of all subscribers ever acquired"
            />
          </div>

          <Card title="MRR by plan" subtitle="Monthly-equivalent revenue, normalized by billing interval" className="mb-6">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              {Object.entries(data.mrr.by_plan).map(([plan, breakdown]) => (
                <div key={plan} className="rounded-md border border-gray-100 p-4">
                  <p className="text-xs font-medium uppercase tracking-wide text-gray-500">
                    {formatPlanLabel(plan)}
                  </p>
                  <p className="mt-1 text-lg font-semibold text-gray-900">{formatCurrency(breakdown.mrr)}</p>
                  <p className="text-xs text-gray-400">{breakdown.active_subscribers} active</p>
                </div>
              ))}
            </div>
          </Card>

          <div className="mb-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
            <Card title="Churn by renewal cycle" subtitle="% of subscribers who cancelled right after reaching each cycle">
              <ResponsiveContainer width="100%" height={260}>
                <BarChart data={data.churn_by_cycle}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
                  <XAxis dataKey="cycle" tick={CHART_TICK_STYLE} tickFormatter={(c) => `Cycle ${c}`} />
                  <YAxis tick={CHART_TICK_STYLE} unit="%" />
                  <Tooltip
                    formatter={(value: number, name) =>
                      name === "churn_rate_pct" ? [`${value}%`, "Churn rate"] : [value, name]
                    }
                    labelFormatter={(c) => `Cycle ${c}`}
                  />
                  <Bar dataKey="churn_rate_pct" fill="#CE202F" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </Card>

            <Card title="Monthly churn rate" subtitle="Cancelled this month / active at start of month">
              <ResponsiveContainer width="100%" height={260}>
                <LineChart data={data.monthly_churn}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
                  <XAxis dataKey="month" tick={CHART_TICK_STYLE} />
                  <YAxis tick={CHART_TICK_STYLE} unit="%" />
                  <Tooltip />
                  <Line type="monotone" dataKey="churn_rate_pct" stroke="#CE202F" strokeWidth={2} dot={{ r: 3 }} />
                </LineChart>
              </ResponsiveContainer>
            </Card>
          </div>

          <Card title="Cohort retention" subtitle="% of each acquisition-month cohort still renewing at each cycle" className="mb-6">
            <CohortHeatmap rows={data.cohort_retention} />
          </Card>

          <Card title="Plan comparison" subtitle="Monthly ($49) vs bimonthly ($88) vs trimonthly ($117)">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-left text-xs font-medium uppercase text-gray-500">
                  <th className="py-2">Plan</th>
                  <th className="py-2 text-right">Total subscribers</th>
                  <th className="py-2 text-right">Active</th>
                  <th className="py-2 text-right">Cancelled</th>
                  <th className="py-2 text-right">Cancellation rate</th>
                  <th className="py-2 text-right">Avg LTV</th>
                </tr>
              </thead>
              <tbody>
                {data.plan_mix.map((row) => (
                  <tr key={row.plan} className="border-b border-gray-100">
                    <td className="py-2 font-medium text-gray-900">{formatPlanLabel(row.plan)}</td>
                    <td className="py-2 text-right">{formatNumber(row.total_subscribers)}</td>
                    <td className="py-2 text-right">{formatNumber(row.active_subscribers)}</td>
                    <td className="py-2 text-right">{formatNumber(row.cancelled_subscribers)}</td>
                    <td className="py-2 text-right">{formatPercent(row.cancellation_rate_pct)}</td>
                    <td className="py-2 text-right">{row.avg_ltv !== null ? formatCurrency(row.avg_ltv) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </div>
      )}
    </DataBoundary>
  );
}
