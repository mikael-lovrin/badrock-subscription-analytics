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
import type { RawAppstleBillingEvent, RawAppstleSubscription, RawLineItem, RawOrder } from "./rawTypes";

export interface Filters {
  products: Set<string> | null; // null = all products
  dateRange: DateRange; // {from: null, to: null} = unbounded
}

function matchesProducts(product: string | null, products: Set<string> | null): boolean {
  if (products === null || products.size === 0) return true;
  return product !== null && products.has(product);
}

/**
 * Applies the global product multi-select to the Appstle real-status
 * ledger. Confirmed 2026-08-04: before this existed, every Appstle-derived
 * view (early-churn cohort, cancellation timing, dunning funnel) ignored
 * the header's product picker entirely and always showed all-products
 * numbers — only the Shopify-inference views (buildContracts and
 * everything downstream of it) actually respected the filter. Callers
 * that want an always-all-products comparison ANYWAY (e.g.
 * computeChurnComparison, whose whole point is comparing scopes) should
 * keep taking the full unfiltered array instead of this.
 */
export function filterAppstleSubsByProduct(
  subs: RawAppstleSubscription[],
  products: Set<string> | null,
): RawAppstleSubscription[] {
  return subs.filter((s) => matchesProducts(s.product, products));
}

/** Same idea for the billing-attempt rows (success/failed/skipped-dunning),
 * which don't carry a product field of their own — joined via contract_id
 * against the subscription ledger to find each event's product. */
export function filterBillingEventsByProduct(
  events: RawAppstleBillingEvent[],
  subs: RawAppstleSubscription[],
  products: Set<string> | null,
): RawAppstleBillingEvent[] {
  if (products === null || products.size === 0) return events;
  const productByContract = new Map(subs.map((s) => [s.id, s.product]));
  return events.filter((e) => matchesProducts(productByContract.get(e.contract_id) ?? null, products));
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
// just being mid-retry on a failed payment. 1.1x (not more) — confirmed
// 2026-07-30: a wider grace window was leaving recently-cancelled
// subscribers misclassified as ACTIVE for too long, understating churn.
const CHURN_GRACE_MULTIPLIER = 1.1;
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
  /** The order's Shopify displayFinancialStatus (PAID/REFUNDED/PARTIALLY_REFUNDED/...) at export time. */
  financialStatus: string;
  /** Resolved product for THIS event specifically — a contract's product
   * can change across events (see buildContracts' customer-level
   * grouping), so this isn't always the same as the contract's current
   * Contract.product. */
  product: string;
  /** Appstle's own appstle_subscription_first_order tag on this event's
   * order — the authoritative signal for "this starts a brand-new
   * subscription", used to split a customer's events into contracts. */
  isAppstleFirstOrder: boolean;
}

const REFUNDED_STATUSES = new Set(["REFUNDED", "PARTIALLY_REFUNDED"]);

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
  /**
   * Whether the LAST order on this contract — the one after which the
   * subscriber went silent — came back REFUNDED or PARTIALLY_REFUNDED.
   * Distinguishes an explicit "I want my money back" cancellation from
   * plain renewal silence (the subscriber just stopped ordering). An
   * order refunded earlier in the contract's history, while the
   * subscriber kept renewing afterward, doesn't count here — it isn't
   * why they eventually stopped.
   */
  lastOrderRefunded: boolean;
}

/**
 * Groups subscription-tagged, non-upsell line items into Contracts, one
 * per continuous subscription lifecycle. Grouped by CUSTOMER first, then
 * split into one or more contracts using Appstle's own
 * appstle_subscription_first_order tag as the authoritative signal for
 * "this order starts a brand-new subscription" — every other tagged order
 * for that customer attaches to whichever contract is currently open.
 *
 * Deliberately NOT grouped by (customer, product): a contract's product
 * can change mid-subscription — a format swap, or just a Shopify product
 * rename — and title-based product resolution has no way to know that's
 * still the same subscription. Confirmed 2026-07-30: a mis-mapped title
 * alias made "BadRock - [R]" resolve to a product name that doesn't even
 * exist in the live catalog, which made 5 real renewals look like 5
 * brand-new subscriptions the moment that title showed up — and even
 * after fixing that one alias, the underlying fragility remains: ANY
 * future rename would silently fracture contract continuity again if
 * product identity were still the grouping key. Trusting Appstle's own
 * first/recurring tag instead is immune to that class of bug — it doesn't
 * care what the product happens to be called this week.
 *
 * Trade-off: this assumes a customer doesn't run two genuinely concurrent,
 * unrelated Appstle subscriptions at once (e.g. Bedroom Bundle AND Beef
 * Organs in parallel) — if that happens, an order missing its
 * first-order tag could get attached to the wrong open contract. No
 * evidence of that pattern in Badrock's order history as of 2026-07-30
 * (one active subscription per customer is the norm); revisit if that
 * changes.
 *
 * Always built from the FULL order history regardless of the date-range
 * filter — cycle counts and active/cancelled status would be wrong if
 * earlier orders were excluded; date-range filtering is applied
 * afterward, per-metric, against `createdAt` (cohort membership). The
 * product filter is likewise applied AFTER contracts are built, against
 * each contract's *current* (most recent) product — filtering candidate
 * line items beforehand would silently truncate a contract's event
 * history mid-way if it ever swapped away from the filtered product.
 *
 * `li.is_upsell` line items (variant-level [U1], e.g. a "Unlock - [R]"
 * product's "1 Bundle [U1]" or "1 Sleep Rest [U1]" AfterSell add-on
 * variant) are excluded from the candidate pool entirely — confirmed
 * against real order data 2026-07-24 that these ride along on the SAME
 * order as the real plan line, same product, same day; counting them as
 * their own billing event would fabricate a same-day "renewal" that never
 * happened. Their revenue still rolls into lifetimeValue.
 *
 * **`status`/`cancelledOn` override from the real Appstle ledger (added
 * 2026-08-04):** confirmed against a real export that the Shopify-silence
 * heuristic below undercounts cancellations substantially — a subscriber
 * who cancels proactively without ever placing (or missing) an order
 * leaves nothing in order history to infer from, so they read as ACTIVE
 * forever (Bedroom Stripes was the extreme case: ~0% inferred churn here
 * vs. ~100% real cancellation in the Appstle ledger). Wherever a contract
 * can be matched to a row in `appstleSubs`, that row's real `status` and
 * `cancellation_date` win outright, overriding the inferred ACTIVE/
 * CANCELLED below; contracts with no match keep using the heuristic — see
 * `matchAppstleSub()`'s doc comment for the join itself and its known
 * limitation (same email+product join used by
 * `computeSkippedDunningExposure`/the Appstle section — there's no shared
 * contract id between Shopify and Appstle, so this is a best-effort match,
 * not a guaranteed-exact one).
 *
 * **Synthetic contracts for Appstle-only subscriptions (added 2026-08-04):**
 * the override above only ever adjusts a contract that already exists from
 * Shopify order history — it never creates one. That's a real gap: once a
 * product's entire order history has aged out of the ETL's 60-day Shopify
 * pull window (see README), there's no Shopify-derived contract left to
 * attach the real Appstle status to, so that product goes completely
 * invisible on every card fed by `buildContracts()` even though Appstle's
 * ledger has its full real history. After the main pass below, a second
 * pass walks every row of `appstleSubs` and, for any (email, product) pair
 * that no Shopify-derived contract ever covered, synthesizes a `Contract`
 * directly from that Appstle row via `synthesizeContractFromAppstleSub()` —
 * prefixed `appstle::` in `contractId` so it can never collide with a
 * Shopify-derived id. See that function's doc comment for exactly which
 * fields are estimated (e.g. per-cycle price from `total_revenue / cycles`)
 * vs. taken as-is from Appstle.
 */
/**
 * Groups Appstle subscription-ledger rows by lowercased email + product —
 * the same join key `computeSkippedDunningExposure`/the Appstle section use
 * (there's no contract id shared between Shopify and Appstle at all, so
 * this is the best correspondence available, not a guaranteed-exact one).
 * Returns a Map so `findMatchingAppstleSub` can disambiguate when a
 * customer has more than one Appstle row for the same product (e.g.
 * cancelled once and resubscribed) by nearest signup date.
 */
function buildAppstleIndexByEmailProduct(appstleSubs: RawAppstleSubscription[]): Map<string, RawAppstleSubscription[]> {
  const index = new Map<string, RawAppstleSubscription[]>();
  for (const sub of appstleSubs) {
    if (!sub.customer_email || !sub.product) continue;
    const key = `${sub.customer_email.toLowerCase()}::${sub.product}`;
    const bucket = index.get(key) ?? [];
    bucket.push(sub);
    index.set(key, bucket);
  }
  return index;
}

/**
 * Finds the Appstle row to trust for one Shopify-inferred contract. Match
 * key is (customer email lowercased, product) — same limitation as noted
 * throughout this file: no shared contract id, so this can be wrong if,
 * say, a customer emails aren't set on the Shopify order (`email === null`
 * — never matches, falls back to the heuristic) or if the same
 * email+product pair legitimately has more than one Appstle row (a
 * cancel-then-resubscribe). In the multiple-match case, picks whichever
 * Appstle row's `created_at` is closest to this contract's own
 * `createdAt` — the best available disambiguator without a shared id.
 */
function findMatchingAppstleSub(
  index: Map<string, RawAppstleSubscription[]>,
  email: string | null,
  product: string,
  contractCreatedAt: string,
): RawAppstleSubscription | null {
  if (!email) return null;
  const bucket = index.get(`${email.toLowerCase()}::${product}`);
  if (!bucket || bucket.length === 0) return null;
  if (bucket.length === 1) return bucket[0];
  const targetTime = new Date(contractCreatedAt).getTime();
  return bucket.reduce((closest, candidate) => {
    if (!candidate.created_at) return closest;
    if (!closest.created_at) return candidate;
    const closestDiff = Math.abs(new Date(closest.created_at).getTime() - targetTime);
    const candidateDiff = Math.abs(new Date(candidate.created_at).getTime() - targetTime);
    return candidateDiff < closestDiff ? candidate : closest;
  }, bucket[0]);
}

/**
 * Synthesizes a Contract directly from an Appstle ledger row, for the case
 * where NO Shopify-derived contract exists to attach real status to at all
 * (see `buildContracts`' second pass below). Returns null when the row
 * can't be turned into a usable contract without inventing data: no
 * product (can't apply the product filter), or no date anywhere to use as
 * `createdAt` (cohort membership) — better to drop the row than guess.
 */
function synthesizeContractFromAppstleSub(sub: RawAppstleSubscription): Contract | null {
  if (!sub.product) return null;
  const createdAt = sub.created_at;
  if (!createdAt) return null;

  const planLabel = sub.interval_months !== null ? MONTHS_TO_LABEL[sub.interval_months] ?? `${sub.interval_months}x monthly` : "unknown";
  const cycles = sub.cycles && sub.cycles > 0 ? sub.cycles : 1;
  const estimatedPrice = Math.round((sub.total_revenue / cycles) * 100) / 100;
  const isCancelled = sub.status.toLowerCase() === "cancelled";

  const event: SubscriptionEvent = {
    date: sub.last_order_date ?? createdAt,
    price: estimatedPrice,
    quantity: 1,
    plan: sub.interval_months ? { months: sub.interval_months, label: planLabel } : null,
    extraRevenue: 0,
    financialStatus: "PAID",
    product: sub.product,
    isAppstleFirstOrder: true,
  };

  return {
    contractId: `appstle::${sub.id}`,
    customerId: `appstle-email::${sub.customer_email.toLowerCase()}`,
    customerEmail: sub.customer_email,
    product: sub.product,
    planLabel,
    intervalMonths: sub.interval_months,
    createdAt,
    events: [event],
    status: isCancelled ? "CANCELLED" : "ACTIVE",
    cancelledOn: sub.cancellation_date,
    lifetimeValue: round2(sub.total_revenue),
    renewalsReached: Math.max(0, (sub.cycles ?? 1) - 1),
    lastOrderRefunded: false,
  };
}

export function buildContracts(
  orders: RawOrder[],
  lineItems: RawLineItem[],
  products: Set<string> | null,
  appstleSubs: RawAppstleSubscription[] = [],
): Contract[] {
  const orderById = new Map(orders.map((o) => [o.id, o]));
  const appstleIndex = buildAppstleIndexByEmailProduct(appstleSubs);
  // Tracks which (email, product) pairs already got a Shopify-derived
  // contract, so the synthetic-contract pass below only fills in the gaps
  // instead of duplicating coverage. Populated during the main loop as each
  // Shopify-derived contract is built.
  const coveredEmailProductKeys = new Set<string>();

  // Step 1: one billing event per (order, product) — never per line item,
  // in case a product still ends up with more than one non-upsell [R]
  // line on the same order (a real edge case, not the common AfterSell
  // pattern above, which is already filtered out via is_upsell).
  const eventsByOrderProduct = new Map<string, { order: RawOrder; candidates: RawLineItem[] }>();
  for (const li of lineItems) {
    if (!li.is_subscription || li.is_upsell || li.product === null) continue;
    const order = orderById.get(li.order_id);
    if (!order || order.financial_status === "VOIDED" || !order.customer_id) continue;
    const key = `${order.id}::${li.product}`;
    const bucket = eventsByOrderProduct.get(key) ?? { order, candidates: [] };
    bucket.candidates.push(li);
    eventsByOrderProduct.set(key, bucket);
  }

  const eventsByCustomer = new Map<string, { email: string | null; events: SubscriptionEvent[] }>();
  for (const { order, candidates } of eventsByOrderProduct.values()) {
    const resolvedLine = candidates.find((li) => planFromLineItem(li) !== null);
    const chosen = resolvedLine ?? candidates.reduce((max, li) => (li.price > max.price ? li : max));
    const otherLinesRevenue = candidates
      .filter((li) => li !== chosen)
      .reduce((sum, li) => sum + li.price * li.quantity, 0);

    const customerId = order.customer_id as string;
    const bucket = eventsByCustomer.get(customerId) ?? { email: order.email, events: [] };
    bucket.events.push({
      date: order.created_at,
      price: chosen.price,
      quantity: chosen.quantity,
      plan: planFromLineItem(chosen),
      extraRevenue: otherLinesRevenue,
      financialStatus: order.financial_status,
      product: chosen.product as string,
      isAppstleFirstOrder: order.is_appstle_first_order,
    });
    eventsByCustomer.set(customerId, bucket);
  }

  const now = new Date();
  const contracts: Contract[] = [];

  for (const [customerId, { email, events }] of eventsByCustomer) {
    events.sort((a, b) => (a.date < b.date ? -1 : 1));

    // Split this customer's chronological events into one or more
    // contracts: a first-order-tagged event always starts a new one;
    // everything else continues whichever contract is currently open.
    const customerContracts: SubscriptionEvent[][] = [];
    let current: SubscriptionEvent[] | null = null;
    for (const event of events) {
      if (event.isAppstleFirstOrder || current === null) {
        current = [];
        customerContracts.push(current);
      }
      current.push(event);
    }

    customerContracts.forEach((contractEvents, idx) => {
      const last = contractEvents[contractEvents.length - 1];
      const intervalMonths = last.plan?.months ?? null;
      const graceMonths = (intervalMonths ?? 1) * CHURN_GRACE_MULTIPLIER;
      const lastEventAt = new Date(last.date);
      const daysSinceLast = (now.getTime() - lastEventAt.getTime()) / 86_400_000;
      const isActive = daysSinceLast <= graceMonths * AVG_DAYS_PER_MONTH;
      const expectedNextBilling = new Date(lastEventAt.getTime() + (intervalMonths ?? 1) * AVG_DAYS_PER_MONTH * 86_400_000);

      let status: "ACTIVE" | "CANCELLED" = isActive ? "ACTIVE" : "CANCELLED";
      let cancelledOn: string | null = isActive ? null : expectedNextBilling.toISOString();

      // Real-Appstle override — see buildContracts' doc comment above. Only
      // applied when a match exists; otherwise the Shopify-silence
      // heuristic just computed above stands as the fallback.
      const matchedSub = findMatchingAppstleSub(appstleIndex, email, last.product, contractEvents[0].date);
      if (matchedSub) {
        const reallyCancelled = matchedSub.status.toLowerCase() === "cancelled";
        status = reallyCancelled ? "CANCELLED" : "ACTIVE";
        cancelledOn = reallyCancelled ? matchedSub.cancellation_date ?? cancelledOn : null;
      }

      contracts.push({
        contractId: `${customerId}::${idx}::${contractEvents[0].product}`,
        customerId,
        customerEmail: email,
        product: last.product,
        planLabel: last.plan?.label ?? "unknown",
        intervalMonths,
        createdAt: contractEvents[0].date,
        events: contractEvents,
        status,
        cancelledOn,
        lifetimeValue: round2(
          contractEvents.reduce((sum, e) => sum + e.price * e.quantity + e.extraRevenue, 0),
        ),
        renewalsReached: contractEvents.length - 1,
        lastOrderRefunded: REFUNDED_STATUSES.has(last.financialStatus),
      });

      if (email) coveredEmailProductKeys.add(`${email.toLowerCase()}::${last.product}`);
    });
  }

  // Second pass — synthesize contracts for Appstle subscriptions that have
  // NO corresponding Shopify-derived contract at all (as opposed to the
  // override above, which only ever REPLACES the status of a contract that
  // already exists). Without this, a product whose entire Shopify order
  // history has rolled off the ETL's 60-day pull window (see README's
  // "Shopify order history is capped at 60 days") ends up with zero
  // Shopify-derived contracts, so every main dashboard card fed by
  // `buildContracts()` (churn-by-cycle, MRR, active-subscriber counts)
  // silently shows that product as empty/zero — even though the Appstle
  // ledger has its full real history. Confirmed case: Bedroom Stripes' 8
  // real subscriptions (created 2026-06-07/08, cancelled 2026-07-06) are
  // fully outside the Shopify order window as of 2026-08-04.
  for (const sub of appstleSubs) {
    if (!sub.customer_email || !sub.product) continue;
    const key = `${sub.customer_email.toLowerCase()}::${sub.product}`;
    if (coveredEmailProductKeys.has(key)) continue;
    const synthesized = synthesizeContractFromAppstleSub(sub);
    if (synthesized) contracts.push(synthesized);
  }

  return contracts.filter((c) => matchesProducts(c.product, products));
}

function contractsInCohortRange(contracts: Contract[], range: DateRange): Contract[] {
  return contracts.filter((c) => inDateRange(toDateOnly(c.createdAt), range));
}

export interface MrrResult {
  totalMrr: number;
  totalActiveSubscribers: number;
  byPlan: Record<string, { activeSubscribers: number; mrr: number }>;
}

/**
 * Current MRR snapshot — always "as of now", not affected by the
 * date-range filter (only by the product filter, already baked into
 * `contracts`).
 *
 * `excludeCustomerEmails`, when passed, drops any otherwise-ACTIVE
 * contract whose customer email is in the set from the MRR sum — used to
 * compute the "excluding skipped-dunning" variant (see
 * computeSkippedDunningExposure below and the Subscriptions page's
 * side-by-side MRR cards). Matched on customer email rather than a
 * contract id because the Shopify-inferred `Contract` here and the
 * Appstle billing-event ledger are two different data sources with no
 * shared contract id — see computeSkippedDunningExposure's doc comment
 * for why this join is approximate, not guaranteed-exact.
 */
export function computeMrr(contracts: Contract[], excludeCustomerEmails?: Set<string>): MrrResult {
  const active = contracts.filter(
    (c) =>
      c.status === "ACTIVE" &&
      c.intervalMonths !== null &&
      !(excludeCustomerEmails && c.customerEmail && excludeCustomerEmails.has(c.customerEmail.toLowerCase())),
  );
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
  /**
   * How many of the cohort have a *resolved* outcome for that cycle —
   * either they reached it, or they're CANCELLED having stalled before
   * reaching it. The denominator behind retentionByCyclePct. Deliberately
   * excludes contracts that are still ACTIVE with renewalsReached < cycle:
   * their renewal date for that cycle hasn't come up yet, so they're
   * neither a retention nor a churn data point — including them in the
   * denominator is what used to make a fresh cohort read as mostly
   * churned when really most of it just hadn't had a chance to renew yet.
   */
  maturedByCycle: Record<number, number>;
  /** Numerator behind retentionByCyclePct — exposed so the UI can show the exact "reached/matured" fraction instead of just the rounded %. */
  reachedByCycle: Record<number, number>;
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
    const maturedByCycle: Record<number, number> = {};
    const reachedByCycle: Record<number, number> = {};
    for (let cycle = 1; cycle <= maxCycle; cycle++) {
      const reached = group.filter((c) => c.renewalsReached >= cycle).length;
      if (reached === 0) break;
      const churnedBeforeReaching = group.filter((c) => c.status === "CANCELLED" && c.renewalsReached < cycle).length;
      const matured = reached + churnedBeforeReaching;
      maturedByCycle[cycle] = matured;
      reachedByCycle[cycle] = reached;
      retentionByCyclePct[cycle] = round2((100 * reached) / matured);
    }
    rows.push({ cohortMonth, plan, cohortSize: group.length, retentionByCyclePct, maturedByCycle, reachedByCycle });
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
  /**
   * Subscribers still on their very first billing cycle (never renewed)
   * and not yet past their grace deadline for it — too new to have had a
   * chance to prove out either way. Excluded from cancellationRatePct's
   * denominator for the same reason immature cohorts are excluded from
   * computeCohortRetention: mixing them in makes the rate float purely
   * with how many people signed up recently, not with actual churn.
   */
  pendingSubscribers: number;
  cancellationRatePct: number;
  /** Of cancelledSubscribers: their last order came back refunded (explicit
   * "give me my money back"), vs. they just stopped ordering and let the
   * subscription lapse silently. See Contract.lastOrderRefunded. */
  cancelledRefunded: number;
  cancelledSilent: number;
  refundShareOfCancelledPct: number;
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
      // Matured = has a resolved outcome for "did it ever renew at least
      // once": either it already cancelled (always resolved, status only
      // flips once its grace deadline has passed), or it renewed at least
      // once already. Still-ACTIVE, still-on-cycle-0 contracts are the
      // only "pending" ones — they haven't had their first chance yet.
      const matured = group.filter((c) => c.status === "CANCELLED" || c.renewalsReached >= 1).length;
      const pending = group.length - matured;
      const cancelledContracts = group.filter((c) => c.status === "CANCELLED");
      const cancelledRefunded = cancelledContracts.filter((c) => c.lastOrderRefunded).length;
      const cancelledSilent = cancelledContracts.length - cancelledRefunded;
      const ltvValues = group.map((c) => c.lifetimeValue);
      return {
        plan,
        totalSubscribers: group.length,
        activeSubscribers: active,
        cancelledSubscribers: cancelled,
        pendingSubscribers: pending,
        cancellationRatePct: matured ? round2((100 * cancelled) / matured) : 0,
        cancelledRefunded,
        cancelledSilent,
        refundShareOfCancelledPct: cancelled ? round2((100 * cancelledRefunded) / cancelled) : 0,
        avgLtv: ltvValues.length ? round2(avg(ltvValues)) : null,
      };
    });
}

// ---------------------------------------------------------------------------
// Appstle cross-check (separate from buildContracts on purpose — see
// 2026-07-31 decision: now that read_all_orders gives full Shopify
// history, buildContracts went back to pure Shopify-order-silence
// inference. Real Appstle status doesn't get blended into contracts
// anymore; it's reported standalone instead, since it's the only source
// that can see a subscriber who cancelled proactively without ever
// missing an order — Shopify history has zero trace of that regardless
// of how much history is available.
// ---------------------------------------------------------------------------

export interface AppstleEarlyChurnRow {
  plan: string;
  totalSubscriptions: number;
  /** Cancelled with 1 or 0 completed billing cycles — i.e. cancelled
   * before ever reaching their first renewal. */
  cancelledBeforeFirstRenewal: number;
  pctOfTotal: number;
}

/** Per-plan breakdown of real Appstle cancellations that happened before
 * the subscriber ever reached their first renewal — the number the
 * Shopify-inference model structurally cannot produce, since a
 * subscriber who cancels without any accompanying order leaves nothing
 * in order history to infer from. */
export function computeAppstleEarlyChurn(appstleSubs: RawAppstleSubscription[]): AppstleEarlyChurnRow[] {
  const byPlan = new Map<string, RawAppstleSubscription[]>();
  for (const sub of appstleSubs) {
    const label = sub.interval_months !== null ? MONTHS_TO_LABEL[sub.interval_months] ?? `${sub.interval_months}x monthly` : "unknown";
    const arr = byPlan.get(label) ?? [];
    arr.push(sub);
    byPlan.set(label, arr);
  }
  return [...byPlan.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([plan, subs]) => {
      const cancelledBeforeFirstRenewal = subs.filter((s) => s.status === "cancelled" && (s.cycles === null || s.cycles <= 1)).length;
      return {
        plan,
        totalSubscriptions: subs.length,
        cancelledBeforeFirstRenewal,
        pctOfTotal: subs.length ? round2((100 * cancelledBeforeFirstRenewal) / subs.length) : 0,
      };
    });
}

export interface AppstleEarlyChurnCohortRow {
  cohortMonth: string;
  plan: string;
  cohortSize: number;
  cancelledBeforeFirstRenewal: number;
  pctCancelledBeforeFirstRenewal: number;
}

/** Same early-churn signal as computeAppstleEarlyChurn, but broken out by
 * acquisition month per plan instead of one flat lifetime total — a flat
 * total hides whether early cancellation is getting better/worse over
 * time, and pools cohorts that haven't had equal time to show the signal
 * yet the same way the Shopify-based cohort retention triangle does. */
export function computeAppstleEarlyChurnCohort(appstleSubs: RawAppstleSubscription[]): AppstleEarlyChurnCohortRow[] {
  const groups = new Map<string, RawAppstleSubscription[]>();
  for (const sub of appstleSubs) {
    if (!sub.created_at) continue;
    const label = sub.interval_months !== null ? MONTHS_TO_LABEL[sub.interval_months] ?? `${sub.interval_months}x monthly` : "unknown";
    const key = `${sub.created_at.slice(0, 7)}::${label}`;
    const arr = groups.get(key) ?? [];
    arr.push(sub);
    groups.set(key, arr);
  }
  const rows: AppstleEarlyChurnCohortRow[] = [];
  for (const [key, subs] of [...groups.entries()].sort()) {
    const [cohortMonth, plan] = key.split("::");
    const cancelledBeforeFirstRenewal = subs.filter((s) => s.status === "cancelled" && (s.cycles === null || s.cycles <= 1)).length;
    rows.push({
      cohortMonth,
      plan,
      cohortSize: subs.length,
      cancelledBeforeFirstRenewal,
      pctCancelledBeforeFirstRenewal: subs.length ? round2((100 * cancelledBeforeFirstRenewal) / subs.length) : 0,
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Real cancellation timing + dunning funnel (Appstle "Analytics" exports,
// added 2026-08-04). Confirms/refutes the two hypotheses from the
// 2026-08-03 team meeting: (1) cancellations aren't clustering right after
// product delivery, they cluster around the renewal date; (2) a small
// early-cancel cohort (0-3 days post-signup) likely maps to refund/
// chargeback behavior rather than dissatisfaction with the product
// itself. Also separates OPERATIONAL churn (Bedroom Stripes / Beef Organs
// stockout, subscribers asked to swap or refund because the physical
// product wasn't ready yet — see cancellation_note) from everything else,
// since pooling the two overstates how much churn reflects real offer
// dissatisfaction.
// ---------------------------------------------------------------------------

// Matches the free-text `cancellation_note` values seen in the CSV so far
// for the Bedroom Stripes / Beef Organs / Dewlyte launch-without-stock
// situation ("FITINHA - SEM ESTOQUE", "SEM ESTOQUE", "SEM ESTOQUE DO
// PRODUTO") — see README for the operational backstory. Deliberately a
// substring match on "estoque" (stock) rather than an exact-value list, so
// new phrasing of the same root cause still gets caught.
const STOCKOUT_NOTE_RE = /estoque/i;

export function isStockoutCancellation(sub: RawAppstleSubscription): boolean {
  return sub.status === "cancelled" && !!sub.cancellation_note && STOCKOUT_NOTE_RE.test(sub.cancellation_note);
}

function daysBetween(fromIso: string, toIso: string): number {
  return (new Date(toIso).getTime() - new Date(fromIso).getTime()) / 86_400_000;
}

export interface CancellationTimingBucket {
  label: string;
  minDays: number;
  maxDays: number | null; // null = open-ended (last bucket)
  count: number;
}

const TIMING_BUCKETS: { label: string; minDays: number; maxDays: number | null }[] = [
  { label: "0-1d", minDays: 0, maxDays: 1 },
  { label: "1-3d", minDays: 1, maxDays: 3 },
  { label: "3-7d", minDays: 3, maxDays: 7 },
  { label: "7-14d", minDays: 7, maxDays: 14 },
  { label: "14-21d", minDays: 14, maxDays: 21 },
  { label: "21-30d", minDays: 21, maxDays: 30 },
  { label: "30-45d", minDays: 30, maxDays: 45 },
  { label: "45-60d", minDays: 45, maxDays: 60 },
  { label: "60-90d", minDays: 60, maxDays: 90 },
  { label: "90d+", minDays: 90, maxDays: null },
];

function bucketize(daysList: number[]): CancellationTimingBucket[] {
  return TIMING_BUCKETS.map((b) => ({
    ...b,
    count: daysList.filter((d) => d >= b.minDays && (b.maxDays === null || d < b.maxDays)).length,
  }));
}

export interface CancellationTimingResult {
  /** Days from contract creation to cancellation date, for contracts that
   * cancelled on/before their first renewal (renewalsReached-equivalent:
   * Appstle cycles <= 1) — this is the bucket that would show a spike near
   * day 0-14 if people were cancelling right after receiving the product. */
  sinceSignupBeforeFirstRenewal: CancellationTimingBucket[];
  /** Days from contract creation to cancellation date, for contracts that
   * had already renewed at least once (cycles > 1) — cancelling well into
   * an established subscription, not a first-impression reaction. */
  sinceSignupAfterFirstRenewal: CancellationTimingBucket[];
  /** Days from the LAST successful order to the cancellation date — only
   * computable where a last_order_date exists (i.e. cycles > 1). Tight
   * clustering near 0-3 days here is the "cancelled right after being
   * charged again" pattern, distinct from "cancelled near the signup
   * anniversary". */
  sinceLastOrder: CancellationTimingBucket[];
  /** Share of ALL cancellations (any cycle) that happened within 3 days of
   * contract creation — the buyer's-remorse/possible-refund window the
   * 2026-08-03 meeting flagged. Directional only: these CSVs don't carry
   * Shopify refund/chargeback status, so this can't confirm the money
   * actually went back, only that the cancellation was very early. */
  earlyCancelWithin3DaysPct: number;
  earlyCancelWithin3DaysCount: number;
  totalCancelledWithDates: number;
}

export function computeCancellationTiming(appstleSubs: RawAppstleSubscription[]): CancellationTimingResult {
  const cancelled = appstleSubs.filter((s) => s.status === "cancelled" && s.created_at && s.cancellation_date);

  const sinceSignup = cancelled.map((s) => ({
    days: daysBetween(s.created_at as string, s.cancellation_date as string),
    beforeFirstRenewal: (s.cycles ?? 1) <= 1,
  }));

  const sinceLastOrderDays = cancelled
    .filter((s) => s.last_order_date)
    .map((s) => daysBetween(s.last_order_date as string, s.cancellation_date as string));

  const earlyCount = sinceSignup.filter((r) => r.days <= 3).length;

  return {
    sinceSignupBeforeFirstRenewal: bucketize(sinceSignup.filter((r) => r.beforeFirstRenewal).map((r) => r.days)),
    sinceSignupAfterFirstRenewal: bucketize(sinceSignup.filter((r) => !r.beforeFirstRenewal).map((r) => r.days)),
    sinceLastOrder: bucketize(sinceLastOrderDays),
    earlyCancelWithin3DaysPct: cancelled.length ? round2((100 * earlyCount) / cancelled.length) : 0,
    earlyCancelWithin3DaysCount: earlyCount,
    totalCancelledWithDates: cancelled.length,
  };
}

export interface ChurnComparisonRow {
  scope: string;
  totalSubscriptions: number;
  cancelled: number;
  churnRatePct: number;
}

/**
 * Side-by-side churn comparison requested at the 2026-08-03 meeting:
 * aggregate (every product) vs. Bundle-only vs. everything-except-the-two
 * launched-without-stock products (Bedroom Stripes, Beef Organs) vs.
 * excluding only cancellations explicitly tagged as stockout-driven
 * (isStockoutCancellation). The last row is the most surgical cut: it
 * keeps Bundle Bedroom Stripes/Beef Organs subscribers who churned for
 * ordinary reasons, and only removes the operational-launch noise.
 */
export function computeChurnComparison(appstleSubs: RawAppstleSubscription[]): ChurnComparisonRow[] {
  const row = (scope: string, subs: RawAppstleSubscription[]): ChurnComparisonRow => {
    const cancelled = subs.filter((s) => s.status === "cancelled").length;
    return {
      scope,
      totalSubscriptions: subs.length,
      cancelled,
      churnRatePct: subs.length ? round2((100 * cancelled) / subs.length) : 0,
    };
  };

  const STOCKOUT_LAUNCH_PRODUCTS = new Set(["Bedroom Stripes", "Beef Organs"]);
  const bundleOnly = appstleSubs.filter((s) => s.product === "Bedroom Bundle");
  const excludingStockoutProducts = appstleSubs.filter((s) => !STOCKOUT_LAUNCH_PRODUCTS.has(s.product ?? ""));
  const excludingStockoutCancellations = appstleSubs.filter((s) => !isStockoutCancellation(s));

  return [
    row("Aggregate (all products)", appstleSubs),
    row("Bedroom Bundle only", bundleOnly),
    row("Excl. Bedroom Stripes + Beef Organs", excludingStockoutProducts),
    row("Excl. stockout-tagged cancellations only", excludingStockoutCancellations),
  ];
}

export interface StockoutChurnRow {
  product: string;
  totalCancelled: number;
  stockoutCancelled: number;
  stockoutSharePct: number;
}

/** Per-product breakdown of how much of that product's cancellation count
 * is explained by the launched-without-stock operational situation vs.
 * everything else (voluntary, silent non-renewal, unknown). */
export function computeStockoutChurnByProduct(appstleSubs: RawAppstleSubscription[]): StockoutChurnRow[] {
  const byProduct = new Map<string, RawAppstleSubscription[]>();
  for (const s of appstleSubs) {
    if (s.status !== "cancelled") continue;
    const key = s.product ?? "(unknown)";
    const arr = byProduct.get(key) ?? [];
    arr.push(s);
    byProduct.set(key, arr);
  }
  return [...byProduct.entries()]
    .map(([product, subs]) => {
      const stockoutCancelled = subs.filter(isStockoutCancellation).length;
      return {
        product,
        totalCancelled: subs.length,
        stockoutCancelled,
        stockoutSharePct: subs.length ? round2((100 * stockoutCancelled) / subs.length) : 0,
      };
    })
    .sort((a, b) => b.totalCancelled - a.totalCancelled);
}

export interface DunningFunnelResult {
  failedAttempts: number;
  skippedDunning: number;
  successfulRetries: number;
  /** Of the DISTINCT contracts that had at least one failed or
   * skipped-dunning event, how many are cancelled vs. still active as of
   * the subscription export (i.e. recovered or at least not yet
   * cancelled). Joined by contract_id against the subscription export. */
  distinctContractsAffected: number;
  contractsNowCancelled: number;
  contractsStillActive: number;
  cancelledSharePct: number;
  topErrorCodes: { code: string; count: number }[];
  attemptCountDistribution: { attempts: number; count: number }[];
}

export function computeDunningFunnel(
  billingEvents: RawAppstleBillingEvent[],
  appstleSubs: RawAppstleSubscription[],
): DunningFunnelResult {
  const statusByContract = new Map(appstleSubs.map((s) => [s.id, s.status]));

  const failed = billingEvents.filter((e) => e.outcome === "failed");
  const skipped = billingEvents.filter((e) => e.outcome === "skipped_dunning");
  const successful = billingEvents.filter((e) => e.outcome === "success");

  const affectedContractIds = new Set([...failed, ...skipped].map((e) => e.contract_id));
  let contractsNowCancelled = 0;
  for (const id of affectedContractIds) {
    if (statusByContract.get(id) === "cancelled") contractsNowCancelled += 1;
  }
  const distinctContractsAffected = affectedContractIds.size;
  const contractsStillActive = distinctContractsAffected - contractsNowCancelled;

  const errorCounts = new Map<string, number>();
  for (const e of [...failed, ...skipped]) {
    if (!e.error_code) continue;
    errorCounts.set(e.error_code, (errorCounts.get(e.error_code) ?? 0) + 1);
  }
  const topErrorCodes = [...errorCounts.entries()]
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => b.count - a.count);

  const attemptCounts = new Map<number, number>();
  for (const e of failed) {
    if (e.attempt_number === null) continue;
    attemptCounts.set(e.attempt_number, (attemptCounts.get(e.attempt_number) ?? 0) + 1);
  }
  const attemptCountDistribution = [...attemptCounts.entries()]
    .map(([attempts, count]) => ({ attempts, count }))
    .sort((a, b) => a.attempts - b.attempts);

  return {
    failedAttempts: failed.length,
    skippedDunning: skipped.length,
    successfulRetries: successful.length,
    distinctContractsAffected,
    contractsNowCancelled,
    contractsStillActive,
    cancelledSharePct: distinctContractsAffected ? round2((100 * contractsNowCancelled) / distinctContractsAffected) : 0,
    topErrorCodes,
    attemptCountDistribution,
  };
}

export interface SkippedDunningExposureRow {
  contractId: string;
  customerEmail: string;
  /** Joined from the subscription ledger via contract_id — null if this
   * contract_id isn't present in the current subscription export at all
   * (a rolling-window mismatch between the two exports, see below). */
  product: string | null;
  lastBillingDate: string | null;
}

export interface SkippedDunningExposureResult {
  currentlySkippedContracts: SkippedDunningExposureRow[];
  currentlySkippedCount: number;
  /** Lowercased customer emails of every currently-skipped contract — fed
   * into computeMrr()'s excludeCustomerEmails to build the
   * "excluding skipped-dunning" MRR figure. */
  currentlySkippedCustomerEmails: Set<string>;
}

/**
 * "Skipped dunning" (Appstle's own term) means: every retry attempt for a
 * failed charge failed, and the contract's configured final action was
 * "skip" rather than "cancel" — the subscription stays ACTIVE in
 * Appstle's ledger, but that billing cycle was never actually paid. This
 * is a THIRD state, distinct from both a normally-paying ACTIVE contract
 * and a CANCELLED one. Left unexposed, these accounts silently count as
 * full-paying ACTIVE subscribers in both the subscriber count and MRR
 * (see computeMrr's excludeCustomerEmails param, fed from this).
 *
 * "Currently skipped" here means: of this contract's known billing-attempt
 * history (success/failed/skipped_dunning rows, most-recent by
 * billing_date), the LAST one is a skipped_dunning row — i.e. no
 * successful charge is known to have happened since. Contracts Appstle's
 * own subscription ledger already shows as "cancelled" are excluded here
 * on purpose — the exposure this surfaces is specifically "still ACTIVE
 * but not actually paying", not a plain, already-recorded cancellation
 * (that's what computeDunningFunnel's cancelledSharePct already covers).
 *
 * IMPORTANT LIMITATION (surface this in the UI, don't just bury it in a
 * comment): the 3 Appstle "Analytics" exports this reads from
 * (success/failed/skipped-dunning past orders) are a rolling ~5-6 week
 * window, not full history (confirmed 2026-08-04, see README). A contract
 * that skipped dunning further back than that window, with no billing
 * activity at all since, won't show ANY row in these exports and is
 * therefore invisible here — this is a lower bound on real skipped-dunning
 * exposure, not a complete count.
 */
export function computeSkippedDunningExposure(
  billingEvents: RawAppstleBillingEvent[],
  appstleSubs: RawAppstleSubscription[],
): SkippedDunningExposureResult {
  const productByContract = new Map(appstleSubs.map((s) => [s.id, s.product]));
  const statusByContract = new Map(appstleSubs.map((s) => [s.id, s.status]));

  const eventsByContract = new Map<string, RawAppstleBillingEvent[]>();
  for (const e of billingEvents) {
    const bucket = eventsByContract.get(e.contract_id) ?? [];
    bucket.push(e);
    eventsByContract.set(e.contract_id, bucket);
  }

  const rows: SkippedDunningExposureRow[] = [];
  for (const [contractId, events] of eventsByContract) {
    const sorted = [...events].sort((a, b) => (a.billing_date ?? "").localeCompare(b.billing_date ?? ""));
    const last = sorted[sorted.length - 1];
    if (last.outcome !== "skipped_dunning") continue;
    if (statusByContract.get(contractId) === "cancelled") continue;

    rows.push({
      contractId,
      customerEmail: last.customer_email,
      product: productByContract.get(contractId) ?? null,
      lastBillingDate: last.billing_date,
    });
  }

  return {
    currentlySkippedContracts: rows,
    currentlySkippedCount: rows.length,
    currentlySkippedCustomerEmails: new Set(rows.map((r) => r.customerEmail.toLowerCase())),
  };
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
