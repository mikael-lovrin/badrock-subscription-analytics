"""
ETL entrypoint: pull -> clean -> export raw JSON.

Run manually with:  python run.py
Run in CI: the hourly GitHub Actions workflow calls this exact script.

Deliberately does no metric computation itself: it pulls Shopify orders and
customers, filters out internal test orders (see load.is_test_order), tags
each order with Appstle's own first-order/renewal signal, and writes the
cleaned rows straight to JSON. Every metric (MRR, churn-by-cycle, cohort
retention, revenue trend, etc.) is computed client-side in
site/src/lib/metricsEngine.ts, reactively, against whatever product
selection and date range the user has picked in the UI — that's what makes
the site's multi-product + date-range filters possible without a backend.

Subscription lifecycle data comes entirely from Shopify order history now:
Badrock's Appstle plan doesn't include External API access (confirmed
2026-07-23, and not worth upgrading for), but Appstle tags every order it
creates with `appstle_subscription_first_order` or
`appstle_subscription_recurring_order` — see load.py's docstring for how
that's used.
"""
from __future__ import annotations

import json
import time
from datetime import datetime, timezone

import load
from config import EXPORT_DIR, load_shopify_config
from shopify_client import ShopifyClient


def main() -> None:
    started = time.monotonic()

    shopify = ShopifyClient(load_shopify_config())

    print("Pulling Shopify orders...")
    order_nodes = list(shopify.iter_orders())
    print(f"  {len(order_nodes)} orders")

    print("Pulling Shopify customers...")
    customer_nodes = list(shopify.iter_customers())
    print(f"  {len(customer_nodes)} customers")

    order_rows, line_item_rows, removed_count = load.orders_and_line_items_from_shopify(order_nodes)
    print(f"Filtered out {removed_count} internal test order(s), kept {len(order_rows)}.")

    customer_rows = load.customers_from_shopify(customer_nodes)

    products = sorted({li["product"] for li in line_item_rows if li["product"] is not None})
    generated_at = datetime.now(timezone.utc).isoformat()

    EXPORT_DIR.mkdir(parents=True, exist_ok=True)

    orders_payload = {
        "generated_at": generated_at,
        "orders": order_rows,
        "line_items": line_item_rows,
    }
    (EXPORT_DIR / "orders.json").write_text(json.dumps(orders_payload, default=str), encoding="utf-8")

    customers_payload = {"generated_at": generated_at, "customers": customer_rows}
    (EXPORT_DIR / "customers.json").write_text(json.dumps(customers_payload, default=str), encoding="utf-8")

    meta_payload = {"generated_at": generated_at, "products": products}
    (EXPORT_DIR / "meta.json").write_text(json.dumps(meta_payload, indent=2), encoding="utf-8")

    elapsed = time.monotonic() - started
    print(f"Exported orders.json ({len(order_rows)} orders), customers.json ({len(customer_rows)} customers).")
    print(f"Products found: {products}")
    print(f"Done in {elapsed:.1f}s")


if __name__ == "__main__":
    main()
