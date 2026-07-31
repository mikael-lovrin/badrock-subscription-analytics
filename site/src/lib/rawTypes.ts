// Mirrors etl/run.py's JSON export exactly — keep in sync whenever the
// ETL's row shape changes. This is now the ONLY data contract between the
// ETL and the site: every metric is computed client-side (see
// metricsEngine.ts) against these raw rows, filtered by whatever product
// selection and date range the user has picked, rather than being
// precomputed per-filter-combination on the Python side.

export interface RawOrder {
  id: string;
  order_name: string;
  created_at: string;
  customer_id: string | null;
  email: string | null;
  total_price: number;
  financial_status: string;
  city: string | null;
  province: string | null;
  country: string | null;
  is_appstle_first_order: boolean;
  is_appstle_recurring_order: boolean;
}

export interface RawLineItem {
  id: string;
  order_id: string;
  title: string;
  variant_title: string | null;
  product: string | null;
  quantity: number;
  price: number;
  is_subscription: boolean;
  /** True when the VARIANT (not the product) is tagged [U1] — e.g. a
   * "Unlock - [R]" product's "1 Bundle [U1]" or "1 Sleep Rest [U1]"
   * variant. Checking only the product title misses these. */
  is_upsell: boolean;
  /** Billing interval in months, parsed from the variant title's bottle
   * count (e.g. "3 Bedroom Bundles [F]" -> 3) when it's a front-end plan
   * variant. null for upsell variants or anything that doesn't match —
   * see metricsEngine.ts's PLAN_BY_PRICE for the price-based fallback. */
  interval_months: number | null;
}

export interface RawCustomer {
  id: string;
  email: string | null;
  first_name: string | null;
  last_name: string | null;
  created_at: string;
  orders_count: number | null;
  total_spent: number;
  city: string | null;
  province: string | null;
  country: string | null;
}

export interface OrdersPayload {
  generated_at: string;
  orders: RawOrder[];
  line_items: RawLineItem[];
}

export interface CustomersPayload {
  generated_at: string;
  customers: RawCustomer[];
}

export interface MetaPayload {
  generated_at: string;
  products: string[];
}

/** A row from a manually-exported Appstle subscription CSV (see
 * etl/appstle_csv.py) — real subscription ledger data, not inferred from
 * order silence. `status` is Appstle's own lowercase string (observed:
 * "active", "cancelled" — "paused" is a plausible third value per the
 * export's Pause columns, not yet seen in a real export). */
export interface RawAppstleSubscription {
  id: string;
  customer_email: string;
  status: string;
  product: string | null;
  created_at: string | null;
  next_order_date: string | null;
  interval_months: number | null;
  cancellation_date: string | null;
  cancellation_reason: string | null;
  cancellation_note: string | null;
  paused_on_date: string | null;
  cycles: number | null;
  total_revenue: number;
  first_order_name: string | null;
  last_order_name: string | null;
  last_order_date: string | null;
}

export interface AppstleSubscriptionsPayload {
  /** When THIS ETL run happened — not when the Appstle data itself was captured, see captured_at. */
  generated_at: string;
  /** When the underlying CSV was actually parsed — the freshest of either
   * a local run right after a new export, or whenever the committed
   * snapshot was last regenerated (see etl/appstle_csv.py). null if no
   * Appstle data has ever been available at all. */
  captured_at: string | null;
  /** Filename of the CSV this was parsed from, or null if no manual
   * export has ever been dropped in etl/manual-exports/. */
  source_file: string | null;
  subscriptions: RawAppstleSubscription[];
}
