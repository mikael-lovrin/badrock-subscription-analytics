import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { CancellationTimingBucket } from "../lib/metricsEngine";

const CHART_TICK_STYLE = { fontSize: 11, fill: "#6b7280" };

interface CancellationTimingChartProps {
  buckets: CancellationTimingBucket[];
  barColor?: string;
}

/**
 * Single-series histogram of "days from X to cancellation" — same bucket
 * shape whether it's fed sinceSignupBeforeFirstRenewal,
 * sinceSignupAfterFirstRenewal, or sinceLastOrder (see metricsEngine's
 * computeCancellationTiming). One brand-red hue throughout, matching the
 * rest of the site's single-accent convention — this is a magnitude
 * encoding (count per bucket), not identity, so it doesn't need a second
 * color.
 */
export function CancellationTimingChart({ buckets, barColor = "#CE202F" }: CancellationTimingChartProps) {
  const total = buckets.reduce((sum, b) => sum + b.count, 0);
  if (total === 0) {
    return <p className="text-sm text-gray-400">No cancellations with usable dates in this scope yet.</p>;
  }
  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={buckets} margin={{ left: 0, right: 8 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" vertical={false} />
        <XAxis dataKey="label" tick={CHART_TICK_STYLE} />
        <YAxis tick={CHART_TICK_STYLE} allowDecimals={false} width={28} />
        <Tooltip
          formatter={(value: number) => [`${value} contract(s)`, "Cancelled"]}
          labelFormatter={(label) => `${label} after`}
        />
        <Bar dataKey="count" fill={barColor} radius={[3, 3, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}
