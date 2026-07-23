import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Card } from "../components/Card";
import { DataBoundary } from "../components/DataBoundary";
import { KpiCard } from "../components/KpiCard";
import { PageHeader } from "../components/PageHeader";
import { formatCurrency, formatNumber } from "../lib/format";
import { useJson } from "../lib/useJson";
import type { CustomersData } from "../lib/types";

const CHART_TICK_STYLE = { fontSize: 11, fill: "#6b7280" };

export function CustomerIntelligence() {
  const state = useJson<CustomersData>("customers.json");

  return (
    <DataBoundary state={state}>
      {(data, generatedAt) => (
        <div>
          <PageHeader title="Customer Intelligence" description="New vs returning customers and acquisition trend." generatedAt={generatedAt} />

          <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
            <KpiCard label="New orders" value={formatNumber(data.new_vs_returning.new_orders)} />
            <KpiCard label="New revenue" value={formatCurrency(data.new_vs_returning.new_revenue)} />
            <KpiCard label="Returning orders" value={formatNumber(data.new_vs_returning.returning_orders)} />
            <KpiCard label="Returning revenue" value={formatCurrency(data.new_vs_returning.returning_revenue)} />
          </div>

          <Card title="New customer acquisition" subtitle="First-ever order date per customer">
            <ResponsiveContainer width="100%" height={280}>
              <BarChart data={data.acquisition_trend}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
                <XAxis dataKey="date" tick={CHART_TICK_STYLE} minTickGap={30} />
                <YAxis tick={CHART_TICK_STYLE} allowDecimals={false} />
                <Tooltip />
                <Bar dataKey="new_customers" fill="#CE202F" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </Card>
        </div>
      )}
    </DataBoundary>
  );
}
