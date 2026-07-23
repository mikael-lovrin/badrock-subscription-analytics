/**
 * All business metrics, computed client-side against the raw orders/line
 * items/customers the ETL exports (see rawTypes.ts) — moved here (out of
 * Python) specifically so the site's product multi-select and date-range
 * filters can recompute everything instantly for any combination the user
 * picks, without a backend or precomputing every combination server-side.
 *
 * Mirrors the metric definitions the old Python metrics/ package used —
 * see each function's comment for the specific formula.
 */
import type { DateRange } from "./FilterContext";
import { enumerateDays, toDateOnly } from "./dateUtils";
import type { RawLineItem, RawOrder } from "./rawTypes";

export interface Filters {
  products: Set<string> | null; // null = all products
  dateRange: DateRange; // {from: null, to: null} = unbounded
}

function matchesProducts(product: string | null, products: Set<string> | null): boolean {
  if (products === null || products.size === 0) return true;
  return product !== null && products.has(product);
}

function inDateRange(dateOnly: string, range: DateRange): boolean {
  if (range.from && dateOnly < range.from) return false;
  if (range.to && dateOnly > range.to) return false;
  return true;
}

/** Order ids that have at least one line item matching the product filter — the unit every order-level filter (revenue, geo, new-vs-returning...) is built from. */
function matchingOrderIds(lineItems: RawLineItem[], products: Set<string> | null): Set<string> {
  if (products === null || products.size === 0) {
    return new Set(lineItems.map((li) => li.order_id));
  }
  return new Set(lineItems.filter((li) => matchesProducts(li.product, products)).map((li) => li.order_id));
}

function filteredOrders(orders: RawOrder[], lineItems: RawLineItem[], filters: Filters): RawOrder[] {
  const matchingIds = matchingOrderIds(lineItems, filters.products);
  return orders.filter(
    (o) =>
      o.financial_status !== "VOIDED" &&
      matchingIds.has(o.id) &&
      inDateRange(toDateOnly(o.created_at), filters.dateRange),
  );
}

// ---------------------------------------------------------------------------
// Revenue / orders (Overview, Products & Upsell pages)
// ---------------------------------------------------------------------------

export interface RevenueSummary {
  totalOrders: number;
  totalRevenue: number;
  aov: number;
  uniqueCustomers: number;
  subscriptionOrderRatePct: number;
}

export function computeRevenueSummary(orders: RawOrder[], lineItems: RawLineItem[], filters: Filters): RevenueSummary {
  const orders_ = filteredOrders(orders, lineItems, filters);
  const orderIds = new Set(orders_.map((o) => o.id));
  const subOrderIds = new Set(lineItems.filter((li) => orderIds.has(li.order_id) && li.is_subscription).map((li) => li.order_id));

  const totalOrders = orders_.length;
  const totalRevenue = orders_.reduce((sum, o) => sum + o.total_price, 0);
  const uniqueCustomers = new Set(orders_.map((o) => o.customer_id).filter(Boolean)).size;

  return {
    totalOrders,
    totalRevenue: round2(totalRevenue),
    aov: totalOrders ? round2(totalRevenue / totalOrders) : 0,
    uniqueCustomers,
    subscriptionOrderRatePct: totalOrders ? round2((100 * subOrderIds.size) / totalOrders) : 0,
  };
}

export interface DailyPoint {
  date: string; // YYYY-MM-DD
  label: string; // DD-MM
  orders: number;
  revenue: number;
}

/** Zero-filled daily revenue trend across the filtered date range (or the min..max order date if no range is set). */
export function computeRevenueTrend(orders: RawOrder[], lineItems: RawLineItem[], filters: Filters): DailyPoint[] {
  const orders_ = filteredOrders(orders, lineItems, filters);
  return bucketDaily(
    orders_.map((o) => ({ date: toDateOnly(o.created_at), revenue: o.total_price })),
    filters.dateRange,
  );
}

function bucketDaily(rows: { date: string; revenue: number }[], range: DateRange): DailyPoint[] {
  if (rows.length === 0) return [];
  const byDate = new Map<string, { orders: number; revenue: number }>();
  for (const r of rows) {
    const bucket = byDate.get(r.date) ?? { orders: 0, revenue: 0 };
    bucket.orders += 1;
    bucket.revenue += r.revenue;
    byDate.set(r.date, bucket);
  }
  const dates = [...byDate.keys()].sort();
  const from = range.from ?? dates[0];
  const to = range.to ?? dates[dates.length - 1];
  return enumerateDays(from, to).map((date) => {
    const bucket = byDate.get(date);
    return {
      date,
      label: `${date.slice(8, 10)}-${date.slice(5, 7)}`,
      orders: bucket?.orders ?? 0,
      revenue: round2(bucket?.revenue ?? 0),
    };
  });
}

export interface ProductRevenueRow {
  title: string;
  units: number;
  orders: number;
  revenue: number;
  avgPrice: number;
}

export function computeTopProducts(orders: RawOrder[], lineItems: RawLineItem[], filters: Filters, limit = 20): ProductRevenueRow[] {
  const validOrderIds = new Set(filteredOrders(orders, lineItems, filters).map((o) => o.id));
  const byTitle = new Map<string, { units: number; orderIds: Set<string>; revenue: number; priceSum: number; count: number }>();
  for (const li of lineItems) {
    if (!validOrderIds.has(li.order_id)) continue;
    if (!matchesProducts(li.product, filters.products)) continue;
    const bucket = byTitle.get(li.title) ?? { units: 0, orderIds: new Set(), revenue: 0, priceSum: 0, count: 0 };
    bucket.units += li.quantity;
    bucket.orderIds.add(li.order_id);
    bucket.revenue += li.price * li.quantity;
    bucket.priceSum += li.price;
    bucket.count += 1;
    byTitle.set(li.title, bucket);
  }
  return [...byTitle.entries()]
    .map(([title, b]) => ({
      title,
      units: b.units,
      orders: b.orderIds.size,
      revenue: round2(b.revenue),
      avgPrice: round2(b.priceSum / b.count),
    }))
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, limit);
}

export interface UpsellAttachRate {
  ordersWithUpsell: number;
  totalOrders: number;
  attachRatePct: number;
}

export function computeUpsellAttachRate(orders: RawOrder[], lineItems: RawLineItem[], filters: Filters): UpsellAttachRate {
  const validOrderIds = new Set(filteredOrders(orders, lineItems, filters).map((o) => o.id));
  const relevantLineItems = lineItems.filter((li) => validOrderIds.has(li.order_id));
  const ordersWithUpsell = new Set(relevantLineItems.filter((li) => li.is_upsell).map((li) => li.order_id));
  return {
    ordersWithUpsell: ordersWithUpsell.size,
    totalOrders: validOrderIds.size,
    attachRatePct: validOrderIds.size ? round2((100 * ordersWithUpsell.size) / validOrderIds.size) : 0,
  };
}

export interface GeoRow {
  key: string;
  orders: number;
  revenue: number;
}

export function computeRevenueByGeo(orders: RawOrder[], lineItems: RawLineItem[], filters: Filters) {
  const orders_ = filteredOrders(orders, lineItems, filters);
  const group = (pick: (o: RawOrder) => string | null): GeoRow[] => {
    const byKey = new Map<string, { orders: number; revenue: number }>();
    for (const o of orders_) {
      const key = pick(o);
      if (!key) continue;
      const bucket = byKey.get(key) ?? { orders: 0, revenue: 0 };
      bucket.orders += 1;
      bucket.revenue += o.total_price;
      byKey.set(key, bucket);
    }
    return [...byKey.entries()]
      .map(([key, b]) => ({ key, orders: b.orders, revenue: round2(b.revenue) }))
      .sort((a, b) => b.revenue - a.revenue);
  };
  return { byCountry: group((o) => o.country), byProvince: group((o) => o.province) };
}

// ---------------------------------------------------------------------------
// Customer intelligence
// ---------------------------------------------------------------------------

export interface NewVsReturning {
  newOrders: number;
  newRevenue: number;
  returningOrders: number;
  returningRevenue: number;
}

export function computeNewVsReturning(orders: RawOrder[], lineItems: RawLineItem[], filters: Filters): NewVsReturning {
  const orders_ = filteredOrders(orders, lineItems, filters);
  const firstOrderByCustomer = new Map<string, string>();
  for (const o of orders_) {
    if (!o.customer_id) continue;
    const existing = firstOrderByCustomer.get(o.customer_id);
    if (!existing || o.created_at < existing) firstOrderByCustomer.set(o.customer_id, o.created_at);
  }
  let newOrders = 0,
    newRevenue = 0,
    returningOrders = 0,
    returningRevenue = 0;
  for (const o of orders_) {
    const isNew = o.customer_id && firstOrderByCustomer.get(o.customer_id) === o.created_at;
    if (isNew) {
      newOrders += 1;
      newRevenue += o.total_price;
    } else {
      returningOrders += 1;
      returningRevenue += o.total_price;
    }
  }
  return { newOrders, newRevenue: round2(newRevenue), returningOrders, returningRevenue: round2(returningRevenue) };
}

export interface AcquisitionPoint {
  date: string;
  label: string;
  newCustomers: number;
}

export function computeAcquisitionTrend(orders: RawOrder[], lineItems: RawLineItem[], filters: Filters): AcquisitionPoint[] {
  const orders_ = filteredOrders(orders, lineItems, filters);
  const firstOrderByCustomer = new Map<string, string>();
  for (const o of orders_) {
    if (!o.customer_id) continue;
    const existing = firstOrderByCustomer.get(o.customer_id);
    if (!existing || o.created_at < existing) firstOrderByCustomer.set(o.customer_id, o.created_at);
  }
  const dailyRows = [...firstOrderByCustomer.values()].map((createdAt) => ({ date: toDateOnly(createdAt), revenue: 0 }));
  return bucketDaily(dailyRows, filters.dateRange).map((d) => ({ date: d.date, label: d.label, newCustomers: d.orders }));
}

// ---------------------------------------------------------------------------
// Subscriptions — the core deliverable. See "Cycle numbering" note below.
// ---------------------------------------------------------------------------

// Fallback subscription unit prices -> billing interval, used only when a
// line item's variant title doesn't parse to a bottle count (see
// planFromLineItem below) — e.g. very old orders predating the current
// variant naming convention. Extend this if a genuinely new price point
// shows up that variant-title parsing also can't resolve.
const PLAN_BY_PRICE: Record<number, { months: number; label: string }> = {
  49: { months: 1, label: "monthly" },
  88: { months: 2, label: "bimonthly" },
  117: { months: 3, label: "trimonthly" },
};

const MONTHS_TO_LABEL: Record<number, string> = { 1: "monthly", 2: "bimonthly", 3: "trimonthly" };

/**
 * Resolves a subscription-tagged line item to its billing plan. Primary
 * signal: `interval_months`, parsed server-side from the variant title's
 * bottle count (e.g. "3 Bedroom Bundles [F]" -> 3 months) — this is
 * robust to promo/test pricing, since it doesn't depend on the price
 * matching a known value at all (confirmed 2026-07-24: a $105.30
 * trimonthly variant at a 10% test discount resolves correctly this way,
 * where price-matching alone would have missed it). Falls back to
 * PLAN_BY_PRICE for older orders without a parseable variant title.
 */
function planFromLineItem(li: RawLineItem): { months: number; label: string } | null {
  if (li.interval_months !== null) {
    return { months: li.interval_months, label: MONTHS_TO_LABEL[li.interval_months] ?? `${li.interval_months}x monthly` };
  }
  return PLAN_BY_PRICE[li.price] ?? null;
}

// How much longer than one full billing interval a subscriber can go
// without a new order before we presume they've cancelled, rather than
// just being mid-retry on a failed payment.
const CHURN_GRACE_MULTIPLIER = 1.5;
const AVG_DAYS_PER_MONTH = 30.44;

interface SubscriptionEvent {
  date: string; // ISO timestamp
  price: number;
  quantity: number;
  plan: { months: number; label: string } | null;
  /** Revenue from other same-order/same-product [R] line items folded into
   * this event (see buildContracts) — e.g. an AfterSell upsell add-on.
   * Counts toward lifetimeValue but not toward the plan/MRR price. */
  extraRevenue: number;
}

export interface Contract {
  contractId: string;
  customerId: string;
  customerEmail: string | null;
  product: string;
  planLabel: string;
  intervalMonths: number | null; // null = price didn't match a known plan
  createdAt: string; // first order (cohort membership date)
  events: SubscriptionEvent[]; // chronological, includes the first order
  status: "ACTIVE" | "CANCELLED";
  cancelledOn: string | null;
  lifetimeValue: number;
  /**
   * Cycle numbering: "renewals reached", NOT total orders. A subscriber
   * with only their initial order has renewalsReached = 0 — they haven't
   * renewed yet, so they don't belong to "renewal cycle 1" until their
   * 2nd successful order. This matches the business definition of "ciclo
   * de renovação 1" = the first time someone renews, not the initial
   * purchase — see the 2026-07-23 conversation that clarified this.
   */
  renewalsReached: number;
}

/**
 * Groups subscription-tagged, non-upsell line items into a Contract per
 * (customer, product), using Appstle's own order tags
 * (appstle_subscription_first_order / appstle_subscription_recurring_order)
 * as the primary signal for "this order belongs to a subscription", with
 * the [R] product-title tag as a fallback for orders that predate or
 * otherwise lack Appstle's tagging. Always built from the FULL order
 * history regardless of the date-range filter — cycle counts and
 * active/cancelled status would be wrong if earlier orders were excluded;
 * date-range filtering is applied afterward, per-metric, against
 * `createdAt` (cohort membership), not by truncating the event list.
 *
 * `li.is_upsell` line items (variant-level [U1], e.g. a "Unlock - [R]"
 * product's "1 Bundle [U1]" or "1 Sleep Rest [U1]" AfterSell add-on
 * variant) are excluded from the candidate pool entirely — confirmed
 * against real order data 2026-07-24 that these ride along on the SAME
 * order as the real plan line, same product, same day; counting them as
 * their own billing event would fabricate a same-day "renewal" that never
 * happened. Their revenue still rolls into lifetimeValue.
 */
export function buildContracts(orders: RawOrder[], lineItems: RawLineItem[], products: Set<string> | null): Contract[] {
  const orderById = new Map(orders.map((o) => [o.id, o]));

  // Step 1: one billing event per (order, product) — never per line item,
  // in case a product still ends up with more than one non-upsell [R]
  // line on the same order (a real edge case, not the common AfterSell
  // pattern above, which is already filtered out via is_upsell).
  const eventsByOrderProduct = new Map<string, { order: RawOrder; candidates: RawLineItem[] }>();
  for (const li of lineItems) {
    if (!li.is_subscription || li.is_upsell || li.product === null) continue;
    if (!matchesProducts(li.product, products)) continue;
    const order = orderById.get(li.order_id);
    if (!order || order.financial_status === "VOIDED" || !order.customer_id) continue;
    const key = `${order.id}::${li.product}`;
    const bucket = eventsByOrderProduct.get(key) ?? { order, candidates: [] };
    bucket.candidates.push(li);
    eventsByOrderProduct.set(key, bucket);
  }

  const groups = new Map<string, { customerId: string; email: string | null; product: string; events: SubscriptionEvent[] }>();
  for (const { order, candidates } of eventsByOrderProduct.values()) {
    const resolvedLine = candidates.find((li) => planFromLineItem(li) !== null);
    const chosen = resolvedLine ?? candidates.reduce((max, li) => (li.price > max.price ? li : max));
    const otherLinesRevenue = candidates
      .filter((li) => li !== chosen)
      .reduce((sum, li) => sum + li.price * li.quantity, 0);

    const product = chosen.product as string;
    const key = `${order.customer_id}::${product}`;
    const group = groups.get(key) ?? { customerId: order.customer_id as string, email: order.email, product, events: [] };
    group.events.push({
      date: order.created_at,
      price: chosen.price,
      quantity: chosen.quantity,
      plan: planFromLineItem(chosen),
      extraRevenue: otherLinesRevenue,
    });
    groups.set(key, group);
  }

  const now = new Date();
  const contracts: Contract[] = [];

  for (const [key, group] of groups) {
    group.events.sort((a, b) => (a.date < b.date ? -1 : 1));
    const last = group.events[group.events.length - 1];
    const intervalMonths = last.plan?.months ?? null;
    const graceMonths = (intervalMonths ?? 1) * CHURN_GRACE_MULTIPLIER;
    const lastEventAt = new Date(last.date);
    const daysSinceLast = (now.getTime() - lastEventAt.getTime()) / 86_400_000;
    const isActive = daysSinceLast <= graceMonths * AVG_DAYS_PER_MONTH;
    const expectedNextBilling = new Date(lastEventAt.getTime() + (intervalMonths ?? 1) * AVG_DAYS_PER_MONTH * 86_400_000);

    contracts.push({
      contractId: key,
      customerId: group.customerId,
      customerEmail: group.email,
      product: group.product,
      planLabel: last.plan?.label ?? "unknown",
      intervalMonths,
      createdAt: group.events[0].date,
      events: group.events,
      status: isActive ? "ACTIVE" : "CANCELLED",
      cancelledOn: isActive ? null : expectedNextBilling.toISOString(),
      lifetimeValue: round2(
        group.events.reduce((sum, e) => sum + e.price * e.quantity + e.extraRevenue, 0),
      ),
      renewalsReached: group.events.length - 1,
    });
  }

  return contracts;
}

function contractsInCohortRange(contracts: Contract[], range: DateRange): Contract[] {
  return contracts.filter((c) => inDateRange(toDateOnly(c.createdAt), range));
}

export interface MrrResult {
  totalMrr: number;
  totalActiveSubscribers: number;
  byPlan: Record<string, { activeSubscribers: number; mrr: number }>;
}

/** Current MRR snapshot — always "as of now", not affected by the date-range filter (only by the product filter, already baked into `contracts`). */
export function computeMrr(contracts: Contract[]): MrrResult {
  const active = contracts.filter((c) => c.status === "ACTIVE" && c.intervalMonths !== null);
  const byPlan: Record<string, { activeSubscribers: number; mrr: number }> = {};
  let totalMrr = 0;
  for (const c of active) {
    const lastEvent = c.events[c.events.length - 1];
    const monthly = (lastEvent.price * lastEvent.quantity) / (c.intervalMonths as number);
    byPlan[c.planLabel] ??= { activeSubscribers: 0, mrr: 0 };
    byPlan[c.planLabel].activeSubscribers += 1;
    byPlan[c.planLabel].mrr += monthly;
    totalMrr += monthly;
  }
  for (const label of Object.keys(byPlan)) byPlan[label].mrr = round2(byPlan[label].mrr);
  return { totalMrr: round2(totalMrr), totalActiveSubscribers: active.length, byPlan };
}

export interface ChurnByCycleRow {
  cycle: number;
  reachedCycle: number;
  cancelledAtThisCycle: number;
  churnRatePct: number;
}

/**
 * For each renewal cycle N (1 = first renewal): how many contracts
 * reached cycle N (renewalsReached >= N), and of those, how many never
 * made it to cycle N+1 because they're CANCELLED with exactly N renewals.
 */
export function computeChurnByCycle(contracts: Contract[], dateRange: DateRange, maxCycle = 12): ChurnByCycleRow[] {
  const cohort = contractsInCohortRange(contracts, dateRange);
  const rows: ChurnByCycleRow[] = [];
  for (let cycle = 1; cycle <= maxCycle; cycle++) {
    const reached = cohort.filter((c) => c.renewalsReached >= cycle);
    if (reached.length === 0) break;
    const cancelledHere = reached.filter((c) => c.renewalsReached === cycle && c.status === "CANCELLED");
    rows.push({
      cycle,
      reachedCycle: reached.length,
      cancelledAtThisCycle: cancelledHere.length,
      churnRatePct: round2((100 * cancelledHere.length) / reached.length),
    });
  }
  return rows;
}

export interface MonthlyChurnRow {
  month: string;
  activeAtStart: number;
  cancelled: number;
  churnRatePct: number;
}

export function computeMonthlyChurn(contracts: Contract[], dateRange: DateRange): MonthlyChurnRow[] {
  const cohort = contractsInCohortRange(contracts, dateRange);
  if (cohort.length === 0) return [];
  const months = new Set<string>();
  for (const c of cohort) {
    months.add(c.createdAt.slice(0, 7));
    if (c.cancelledOn) months.add(c.cancelledOn.slice(0, 7));
  }
  const sortedMonths = [...months].sort();
  return sortedMonths.map((month) => {
    const monthStart = `${month}-01`;
    let activeAtStart = 0;
    let cancelledThisMonth = 0;
    for (const c of cohort) {
      if (c.createdAt.slice(0, 10) >= monthStart) continue;
      const wasActiveAtStart = c.cancelledOn === null || c.cancelledOn.slice(0, 10) >= monthStart;
      if (wasActiveAtStart) {
        activeAtStart += 1;
        if (c.cancelledOn && c.cancelledOn.slice(0, 7) === month) cancelledThisMonth += 1;
      }
    }
    return {
      month,
      activeAtStart,
      cancelled: cancelledThisMonth,
      churnRatePct: activeAtStart ? round2((100 * cancelledThisMonth) / activeAtStart) : 0,
    };
  });
}

export interface CohortRetentionRow {
  cohortMonth: string;
  plan: string;
  cohortSize: number;
  retentionByCyclePct: Record<number, number>;
}

export function computeCohortRetention(contracts: Contract[], dateRange: DateRange, maxCycle = 12): CohortRetentionRow[] {
  const cohort = contractsInCohortRange(contracts, dateRange);
  const groups = new Map<string, Contract[]>();
  for (const c of cohort) {
    const key = `${c.createdAt.slice(0, 7)}::${c.planLabel}`;
    const arr = groups.get(key) ?? [];
    arr.push(c);
    groups.set(key, arr);
  }
  const rows: CohortRetentionRow[] = [];
  for (const [key, group] of [...groups.entries()].sort()) {
    const [cohortMonth, plan] = key.split("::");
    const retentionByCyclePct: Record<number, number> = {};
    for (let cycle = 1; cycle <= maxCycle; cycle++) {
      const reached = group.filter((c) => c.renewalsReached >= cycle).length;
      if (reached === 0) break;
      retentionByCyclePct[cycle] = round2((100 * reached) / group.length);
    }
    rows.push({ cohortMonth, plan, cohortSize: group.length, retentionByCyclePct });
  }
  return rows;
}

export interface LtvResult {
  overallAvgLtv: number;
  sampleSize: number;
  byPlan: Record<string, { avgLtv: number; sampleSize: number }>;
}

export function computeLtv(contracts: Contract[], dateRange: DateRange): LtvResult {
  const cohort = contractsInCohortRange(contracts, dateRange);
  if (cohort.length === 0) return { overallAvgLtv: 0, sampleSize: 0, byPlan: {} };
  const byPlan: Record<string, number[]> = {};
  for (const c of cohort) (byPlan[c.planLabel] ??= []).push(c.lifetimeValue);
  const all = cohort.map((c) => c.lifetimeValue);
  return {
    overallAvgLtv: round2(avg(all)),
    sampleSize: all.length,
    byPlan: Object.fromEntries(Object.entries(byPlan).map(([k, v]) => [k, { avgLtv: round2(avg(v)), sampleSize: v.length }])),
  };
}

export interface AvgLifespanResult {
  avgLifespanDays: number | null;
  sampleSize: number;
  byPlan: Record<string, { avgLifespanDays: number; sampleSize: number }>;
}

export function computeAvgLifespan(contracts: Contract[], dateRange: DateRange): AvgLifespanResult {
  const cancelled = contractsInCohortRange(
    contracts.filter((c) => c.status === "CANCELLED"),
    dateRange,
  );
  if (cancelled.length === 0) return { avgLifespanDays: null, sampleSize: 0, byPlan: {} };
  const days = (c: Contract) => (new Date(c.cancelledOn as string).getTime() - new Date(c.createdAt).getTime()) / 86_400_000;
  const byPlan: Record<string, number[]> = {};
  for (const c of cancelled) (byPlan[c.planLabel] ??= []).push(days(c));
  const all = cancelled.map(days);
  return {
    avgLifespanDays: round1(avg(all)),
    sampleSize: all.length,
    byPlan: Object.fromEntries(Object.entries(byPlan).map(([k, v]) => [k, { avgLifespanDays: round1(avg(v)), sampleSize: v.length }])),
  };
}

export interface PlanMixRow {
  plan: string;
  totalSubscribers: number;
  activeSubscribers: number;
  cancelledSubscribers: number;
  cancellationRatePct: number;
  avgLtv: number | null;
}

export function computePlanMix(contracts: Contract[], dateRange: DateRange): PlanMixRow[] {
  const cohort = contractsInCohortRange(contracts, dateRange);
  const byPlan = new Map<string, Contract[]>();
  for (const c of cohort) {
    const arr = byPlan.get(c.planLabel) ?? [];
    arr.push(c);
    byPlan.set(c.planLabel, arr);
  }
  return [...byPlan.entries()]
    .sort()
    .map(([plan, group]) => {
      const active = group.filter((c) => c.status === "ACTIVE").length;
      const cancelled = group.filter((c) => c.status === "CANCELLED").length;
      const ltvValues = group.map((c) => c.lifetimeValue);
      return {
        plan,
        totalSubscribers: group.length,
        activeSubscribers: active,
        cancelledSubscribers: cancelled,
        cancellationRatePct: group.length ? round2((100 * cancelled) / group.length) : 0,
        avgLtv: ltvValues.length ? round2(avg(ltvValues)) : null,
      };
    });
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
function avg(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}
