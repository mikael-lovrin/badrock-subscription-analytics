import { useMemo } from "react";
import { Card } from "../components/Card";
import { DataBoundary } from "../components/DataBoundary";
import { KpiCard } from "../components/KpiCard";
import { PageHeader } from "../components/PageHeader";
import { useFilters } from "../lib/FilterContext";
import { formatCurrency, formatNumber, formatPercent } from "../lib/format";
import { computeTopProducts, computeUpsellAttachRate } from "../lib/metricsEngine";
import type { RawData } from "../lib/useRawData";

function ProductsContent({ data }: { data: RawData }) {
  const { selectedProducts, dateRange } = useFilters();
  const filters = { products: selectedProducts, dateRange };

  const topProducts = useMemo(() => computeTopProducts(data.orders, data.lineItems, filters), [data, selectedProducts, dateRange]);
  const upsell = useMemo(() => computeUpsellAttachRate(data.orders, data.lineItems, filters), [data, selectedProducts, dateRange]);

  return (
    <div>
      <PageHeader title="Products & Upsell" description="Top SKUs by revenue and post-purchase upsell attach rate." generatedAt={data.generatedAt} />

      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-3">
        <KpiCard
          label="Upsell attach rate"
          value={formatPercent(upsell.attachRatePct)}
          hint={`${upsell.ordersWithUpsell} of ${upsell.totalOrders} orders`}
        />
      </div>

      <Card title="Top products" subtitle="By revenue, in the selected date range">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="border-b border-gray-200 text-left text-xs font-medium uppercase text-gray-500">
              <th className="py-2">Title</th>
              <th className="py-2 text-right">Units</th>
              <th className="py-2 text-right">Orders</th>
              <th className="py-2 text-right">Revenue</th>
              <th className="py-2 text-right">Avg price</th>
            </tr>
          </thead>
          <tbody>
            {topProducts.map((p) => (
              <tr key={p.title} className="border-b border-gray-100">
                <td className="py-2 text-gray-900">{p.title}</td>
                <td className="py-2 text-right">{formatNumber(p.units)}</td>
                <td className="py-2 text-right">{formatNumber(p.orders)}</td>
                <td className="py-2 text-right">{formatCurrency(p.revenue)}</td>
                <td className="py-2 text-right">{formatCurrency(p.avgPrice)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

export function Products() {
  return <DataBoundary>{(data) => <ProductsContent data={data} />}</DataBoundary>;
}
