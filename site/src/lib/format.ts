export function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(value);
}

export function formatPercent(value: number): string {
  return `${value.toFixed(1)}%`;
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

export function formatRelativeTime(isoTimestamp: string): string {
  const diffMs = Date.now() - new Date(isoTimestamp).getTime();
  const diffMinutes = Math.round(diffMs / 60000);
  if (diffMinutes < 1) return "just now";
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.round(diffHours / 24);
  return `${diffDays}d ago`;
}

/**
 * Plan labels come from metricsEngine as "monthly" / "bimonthly" /
 * "trimonthly" / "unknown". "unknown" covers line items priced outside the
 * three standard plan prices ($49/$88/$117) — in practice this is mostly
 * discount/promo-code orders (e.g. $39, $69, $105.30), not a systematic
 * new plan; see PLAN_BY_PRICE in metricsEngine.ts.
 */
export function formatPlanLabel(plan: string): string {
  if (plan === "unknown") return "Other (custom price)";
  return plan.charAt(0).toUpperCase() + plan.slice(1);
}
