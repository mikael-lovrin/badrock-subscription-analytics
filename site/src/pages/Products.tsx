import { Card } from "../components/Card";
import { DataBoundary } from "../components/DataBoundary";
import { KpiCard } from "../components/KpiCard";
import { PageHeader } from "../components/PageHeader";
import { formatCurrency, formatNumber, formatPercent } from "../lib/format";
import { useJson } from "../lib/useJson";
import type { RevenueData } from "../lib/types";

export function Products() {
  const state = useJson<RevenueData>("revenue.json");

  return (
    <DataBoundary state={state}>
      {(data, generatedAt) => (
        <div>
          <PageHeader title="Products & Upsell" description="Top SKUs by revenue and post-purchase upsell attach rate." generatedAt={generatedAt} />

          <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-3">
            <KpiCard
              label="Upsell attach rate"
              value={formatPercent(data.upsell_attach_rate.attach_rate_pct)}
              hint={`${data.upsell_attach_rate.orders_with_upsell} of ${data.upsell_attach_rate.total_orders} orders`}
            />
          </div>

          <Card title="Top products" subtitle="By revenue, all-time">
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
                {data.top_products.map((p) => (
                  <tr key={p.title} className="border-b border-gray-100">
                    <td className="py-2 text-gray-900">{p.title}</td>
                    <td className="py-2 text-right">{formatNumber(p.units)}</td>
                    <td className="py-2 text-right">{formatNumber(p.orders)}</td>
                    <td className="py-2 text-right">{formatCurrency(p.revenue)}</td>
                    <td className="py-2 text-right">{formatCurrency(p.avg_price)}</td>
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
