import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Card } from "../components/Card";
import { DataBoundary } from "../components/DataBoundary";
import { KpiCard } from "../components/KpiCard";
import { PageHeader } from "../components/PageHeader";
import { formatCurrency, formatNumber, formatPercent } from "../lib/format";
import { useJson } from "../lib/useJson";
import type { RevenueData, SubscriptionsData } from "../lib/types";

const CHART_TICK_STYLE = { fontSize: 11, fill: "#6b7280" };

export function Overview() {
  const revenue = useJson<RevenueData>("revenue.json");
  const subscriptions = useJson<SubscriptionsData>("subscriptions.json");

  return (
    <DataBoundary state={revenue}>
      {(revenueData, generatedAt) => (
        <div>
          <PageHeader title="Overview" description="Store-wide revenue and order KPIs." generatedAt={generatedAt} />

          <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
            <KpiCard label="Total revenue" value={formatCurrency(revenueData.summary.total_revenue)} />
            <KpiCard label="Orders" value={formatNumber(revenueData.summary.total_orders)} />
            <KpiCard label="AOV" value={formatCurrency(revenueData.summary.aov)} />
            <KpiCard
              label="MRR"
              value={
                subscriptions.status === "ready" ? formatCurrency(subscriptions.envelope.data.mrr.total_mrr) : "…"
              }
              hint="See Subscriptions for full breakdown"
            />
          </div>

          <Card title="Revenue trend" subtitle="Daily revenue, all orders" className="mb-6">
            <ResponsiveContainer width="100%" height={280}>
              <AreaChart data={revenueData.revenue_trend}>
                <defs>
                  <linearGradient id="revenueFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#CE202F" stopOpacity={0.25} />
                    <stop offset="100%" stopColor="#CE202F" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
                <XAxis dataKey="date" tick={CHART_TICK_STYLE} minTickGap={30} />
                <YAxis tick={CHART_TICK_STYLE} tickFormatter={(v) => formatCurrency(v)} width={70} />
                <Tooltip formatter={(v: number) => formatCurrency(v)} />
                <Area type="monotone" dataKey="revenue" stroke="#CE202F" strokeWidth={2} fill="url(#revenueFill)" />
              </AreaChart>
            </ResponsiveContainer>
          </Card>

          <Card title="Subscription order rate" subtitle="Share of orders containing a recurring [R] item">
            <p className="text-2xl font-semibold text-gray-900">
              {formatPercent(revenueData.summary.subscription_order_rate_pct)}
            </p>
          </Card>
        </div>
      )}
    </DataBoundary>
  );
}
