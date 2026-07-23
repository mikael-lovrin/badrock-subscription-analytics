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
