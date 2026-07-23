// Mirrors the JSON shape written by etl/export.py — keep these two in sync
// whenever a metrics function's return shape changes.

export interface Envelope<T> {
  generated_at: string;
  data: T;
}

export interface PlanBreakdown {
  active_subscribers: number;
  mrr: number;
}

export interface SubscriptionsData {
  mrr: {
    total_mrr: number;
    total_active_subscribers: number;
    by_plan: Record<string, PlanBreakdown>;
  };
  churn_by_cycle: {
    cycle: number;
    reached_cycle: number;
    cancelled_at_this_cycle: number;
    churn_rate_pct: number;
  }[];
  monthly_churn: {
    month: string;
    active_at_start: number;
    cancelled: number;
    churn_rate_pct: number;
  }[];
  cohort_retention: {
    cohort_month: string;
    plan: string;
    cohort_size: number;
    retention_by_cycle_pct: Record<string, number>;
  }[];
  ltv: {
    overall_avg_ltv: number;
    sample_size: number;
    by_plan: Record<string, { avg_ltv: number; sample_size: number }>;
  };
  average_lifespan: {
    avg_lifespan_days: number | null;
    sample_size: number;
    by_plan: Record<string, { avg_lifespan_days: number; sample_size: number }>;
  };
  plan_mix: {
    plan: string;
    total_subscribers: number;
    active_subscribers: number;
    cancelled_subscribers: number;
    cancellation_rate_pct: number;
    avg_ltv: number | null;
  }[];
}

export interface RevenueData {
  summary: {
    total_orders: number;
    total_revenue: number;
    aov: number;
    unique_customers: number;
    subscription_order_rate_pct: number;
  };
  revenue_trend: { date: string; orders: number; revenue: number }[];
  top_products: {
    title: string;
    units: number;
    orders: number;
    revenue: number;
    avg_price: number;
  }[];
  upsell_attach_rate: {
    orders_with_upsell: number;
    total_orders: number;
    attach_rate_pct: number;
  };
  revenue_by_geo: {
    by_country: { country: string; orders: number; revenue: number }[];
    by_province: { province: string; orders: number; revenue: number }[];
  };
}

export interface CustomersData {
  new_vs_returning: {
    new_orders: number;
    new_revenue: number;
    returning_orders: number;
    returning_revenue: number;
  };
  acquisition_trend: { date: string; new_customers: number }[];
}
