import { useMemo } from "react";
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
import { useFilters } from "../lib/FilterContext";
import { formatCurrency, formatNumber, formatPercent, formatPlanLabel } from "../lib/format";
import {
  buildContracts,
  computeAvgLifespan,
  computeChurnByCycle,
  computeLtv,
  computeMonthlyChurn,
  computeMrr,
  computeCohortRetention,
  computePlanMix,
} from "../lib/metricsEngine";
import type { RawData } from "../lib/useRawData";

const CHART_TICK_STYLE = { fontSize: 11, fill: "#6b7280" };

function SubscriptionsContent({ data }: { data: RawData }) {
  const { selectedProducts, dateRange } = useFilters();

  const contracts = useMemo(
    () => buildContracts(data.orders, data.lineItems, selectedProducts),
    [data.orders, data.lineItems, selectedProducts],
  );
  const mrr = useMemo(() => computeMrr(contracts), [contracts]);
  const churnByCycle = useMemo(() => computeChurnByCycle(contracts, dateRange), [contracts, dateRange]);
  const monthlyChurn = useMemo(() => computeMonthlyChurn(contracts, dateRange), [contracts, dateRange]);
  const cohortRetention = useMemo(() => computeCohortRetention(contracts, dateRange), [contracts, dateRange]);
  const ltv = useMemo(() => computeLtv(contracts, dateRange), [contracts, dateRange]);
  const avgLifespan = useMemo(() => computeAvgLifespan(contracts, dateRange), [contracts, dateRange]);
  const planMix = useMemo(() => computePlanMix(contracts, dateRange), [contracts, dateRange]);

  const totalSubscribers = planMix.reduce((sum, p) => sum + p.totalSubscribers, 0);
  const totalCancelled = planMix.reduce((sum, p) => sum + p.cancelledSubscribers, 0);

  return (
    <div>
      <PageHeader
        title="Subscriptions"
        description="MRR, renewal-cycle churn, cohort retention and LTV."
        generatedAt={data.generatedAt}
      />

      <div className="mb-6 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
        <p className="font-medium">Estimated, not observed</p>
        <p className="mt-1">
          Badrock's Appstle plan doesn't include API access, so these numbers are derived from Shopify order history
          instead of a real billing ledger: a subscriber counts as <strong>ACTIVE</strong> if a new order arrived
          within 1.5× their billing interval, otherwise <strong>CANCELLED</strong> as of their expected next billing
          date (the date they were due to renew — see the "Date do churn" convention agreed on 2026-07-23). There is
          no real cancellation event behind that, it's inferred from renewal silence.
        </p>
      </div>

      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <KpiCard label="MRR" value={formatCurrency(mrr.totalMrr)} hint={`${mrr.totalActiveSubscribers} active subscribers`} />
        <KpiCard label="Avg LTV (to date)" value={formatCurrency(ltv.overallAvgLtv)} hint="Rises until the full cohort has churned" />
        <KpiCard
          label="Avg subscriber lifespan"
          value={avgLifespan.avgLifespanDays !== null ? `${Math.round(avgLifespan.avgLifespanDays)} days` : "—"}
          hint={`Based on ${avgLifespan.sampleSize} churned subscriber(s)`}
        />
        <KpiCard
          label="Cancellation rate"
          value={formatPercent(totalSubscribers ? (100 * totalCancelled) / totalSubscribers : 0)}
          hint="Of all subscribers ever acquired"
        />
      </div>

      <Card title="MRR by plan" subtitle="Monthly-equivalent revenue, normalized by billing interval" className="mb-6">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          {Object.entries(mrr.byPlan).map(([plan, breakdown]) => (
            <div key={plan} className="rounded-md border border-gray-100 p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-gray-500">{formatPlanLabel(plan)}</p>
              <p className="mt-1 text-lg font-semibold text-gray-900">{formatCurrency(breakdown.mrr)}</p>
              <p className="text-xs text-gray-400">{breakdown.activeSubscribers} active</p>
            </div>
          ))}
        </div>
      </Card>

      <div className="mb-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card title="Churn by renewal cycle" subtitle="% of subscribers who cancelled right after reaching each renewal">
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={churnByCycle}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
              <XAxis dataKey="cycle" tick={CHART_TICK_STYLE} tickFormatter={(c) => `Renewal ${c}`} />
              <YAxis tick={CHART_TICK_STYLE} unit="%" />
              <Tooltip
                formatter={(value: number, name) => (name === "churnRatePct" ? [`${value}%`, "Churn rate"] : [value, name])}
                labelFormatter={(c) => `Renewal ${c}`}
              />
              <Bar dataKey="churnRatePct" fill="#CE202F" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </Card>

        <Card title="Monthly churn rate" subtitle="Cancelled this month / active at start of month">
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={monthlyChurn}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
              <XAxis dataKey="month" tick={CHART_TICK_STYLE} />
              <YAxis tick={CHART_TICK_STYLE} unit="%" />
              <Tooltip />
              <Line type="monotone" dataKey="churnRatePct" stroke="#CE202F" strokeWidth={2} dot={{ r: 3 }} />
            </LineChart>
          </ResponsiveContainer>
        </Card>
      </div>

      <Card title="Cohort retention" subtitle="% of each acquisition-month cohort still renewing at each renewal cycle" className="mb-6">
        <CohortHeatmap rows={cohortRetention} />
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
            {planMix.map((row) => (
              <tr key={row.plan} className="border-b border-gray-100">
                <td className="py-2 font-medium text-gray-900">{formatPlanLabel(row.plan)}</td>
                <td className="py-2 text-right">{formatNumber(row.totalSubscribers)}</td>
                <td className="py-2 text-right">{formatNumber(row.activeSubscribers)}</td>
                <td className="py-2 text-right">{formatNumber(row.cancelledSubscribers)}</td>
                <td className="py-2 text-right">{formatPercent(row.cancellationRatePct)}</td>
                <td className="py-2 text-right">{row.avgLtv !== null ? formatCurrency(row.avgLtv) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

export function Subscriptions() {
  return <DataBoundary>{(data) => <SubscriptionsContent data={data} />}</DataBoundary>;
}
