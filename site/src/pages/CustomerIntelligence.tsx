import { useMemo } from "react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Card } from "../components/Card";
import { DataBoundary } from "../components/DataBoundary";
import { KpiCard } from "../components/KpiCard";
import { PageHeader } from "../components/PageHeader";
import { useFilters } from "../lib/FilterContext";
import { formatCurrency, formatNumber } from "../lib/format";
import { computeAcquisitionTrend, computeNewVsReturning } from "../lib/metricsEngine";
import type { RawData } from "../lib/useRawData";

const CHART_TICK_STYLE = { fontSize: 11, fill: "#6b7280" };

function CustomerIntelligenceContent({ data }: { data: RawData }) {
  const { selectedProducts, dateRange } = useFilters();
  const filters = { products: selectedProducts, dateRange };

  const newVsReturning = useMemo(() => computeNewVsReturning(data.orders, data.lineItems, filters), [data, selectedProducts, dateRange]);
  const acquisitionTrend = useMemo(() => computeAcquisitionTrend(data.orders, data.lineItems, filters), [data, selectedProducts, dateRange]);

  return (
    <div>
      <PageHeader title="Customer Intelligence" description="New vs returning customers and acquisition trend." generatedAt={data.generatedAt} />

      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <KpiCard label="New orders" value={formatNumber(newVsReturning.newOrders)} />
        <KpiCard label="New revenue" value={formatCurrency(newVsReturning.newRevenue)} />
        <KpiCard label="Returning orders" value={formatNumber(newVsReturning.returningOrders)} />
        <KpiCard label="Returning revenue" value={formatCurrency(newVsReturning.returningRevenue)} />
      </div>

      <Card title="New customer acquisition" subtitle="First-ever order date per customer, within the selected filters">
        <ResponsiveContainer width="100%" height={280}>
          <BarChart data={acquisitionTrend}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
            <XAxis dataKey="label" tick={CHART_TICK_STYLE} minTickGap={30} />
            <YAxis tick={CHART_TICK_STYLE} allowDecimals={false} />
            <Tooltip />
            <Bar dataKey="newCustomers" fill="#CE202F" radius={[3, 3, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </Card>
    </div>
  );
}

export function CustomerIntelligence() {
  return <DataBoundary>{(data) => <CustomerIntelligenceContent data={data} />}</DataBoundary>;
}
