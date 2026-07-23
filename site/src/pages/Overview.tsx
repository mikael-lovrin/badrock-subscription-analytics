import { useMemo } from "react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Card } from "../components/Card";
import { DataBoundary } from "../components/DataBoundary";
import { KpiCard } from "../components/KpiCard";
import { PageHeader } from "../components/PageHeader";
import { useFilters } from "../lib/FilterContext";
import { formatCurrency, formatNumber, formatPercent } from "../lib/format";
import { buildContracts, computeMrr, computeRevenueSummary, computeRevenueTrend } from "../lib/metricsEngine";
import type { RawData } from "../lib/useRawData";

const CHART_TICK_STYLE = { fontSize: 11, fill: "#6b7280" };

function OverviewContent({ data }: { data: RawData }) {
  const { selectedProducts, dateRange } = useFilters();
  const filters = { products: selectedProducts, dateRange };

  const summary = useMemo(() => computeRevenueSummary(data.orders, data.lineItems, filters), [data, selectedProducts, dateRange]);
  const trend = useMemo(() => computeRevenueTrend(data.orders, data.lineItems, filters), [data, selectedProducts, dateRange]);
  const contracts = useMemo(() => buildContracts(data.orders, data.lineItems, selectedProducts), [data, selectedProducts]);
  const mrr = useMemo(() => computeMrr(contracts), [contracts]);

  return (
    <div>
      <PageHeader title="Overview" description="Store-wide revenue and order KPIs." generatedAt={data.generatedAt} />

      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <KpiCard label="Total revenue" value={formatCurrency(summary.totalRevenue)} />
        <KpiCard label="Orders" value={formatNumber(summary.totalOrders)} />
        <KpiCard label="AOV" value={formatCurrency(summary.aov)} />
        <KpiCard label="MRR" value={formatCurrency(mrr.totalMrr)} hint="See Subscriptions for full breakdown" />
      </div>

      <Card title="Revenue trend" subtitle="Daily revenue" className="mb-6">
        <ResponsiveContainer width="100%" height={280}>
          <AreaChart data={trend}>
            <defs>
              <linearGradient id="revenueFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#CE202F" stopOpacity={0.25} />
                <stop offset="100%" stopColor="#CE202F" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
            <XAxis dataKey="label" tick={CHART_TICK_STYLE} minTickGap={30} />
            <YAxis tick={CHART_TICK_STYLE} tickFormatter={(v) => formatCurrency(v)} width={70} />
            <Tooltip formatter={(v: number) => formatCurrency(v)} />
            <Area type="monotone" dataKey="revenue" stroke="#CE202F" strokeWidth={2} fill="url(#revenueFill)" />
          </AreaChart>
        </ResponsiveContainer>
      </Card>

      <Card title="Subscription order rate" subtitle="Share of orders containing a recurring [R] item">
        <p className="text-2xl font-semibold text-gray-900">{formatPercent(summary.subscriptionOrderRatePct)}</p>
      </Card>
    </div>
  );
}

export function Overview() {
  return <DataBoundary>{(data) => <OverviewContent data={data} />}</DataBoundary>;
}
