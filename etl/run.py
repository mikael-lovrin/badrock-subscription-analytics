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

Subscription lifecycle data is Shopify order history (see load.py) PLUS,
where available, a manually-exported Appstle subscription CSV (see
appstle_csv.py) — Badrock's Appstle plan doesn't include API access
(confirmed 2026-07-23), so that CSV has to be dropped into
manual-exports/ by hand rather than pulled automatically. The Appstle
export is real subscription-status ground truth and wins wherever it can
be matched to a contract (site/src/lib/metricsEngine.ts's buildContracts);
the Shopify-order-silence inference is a fallback for whatever it can't
match.
"""
from __future__ import annotations

import json
import os
import time
from datetime import datetime, timezone

import appstle_csv
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

    appstle_export_path = appstle_csv.find_latest_export()
    if appstle_export_path:
        # Fresh raw CSV sitting in manual-exports/ (local dev, right after
        # Mikael drops a new export) — parse it and refresh the committed
        # snapshot so CI has something to fall back on later.
        appstle_rows, appstle_removed = appstle_csv.load_appstle_subscriptions(appstle_export_path)
        source_label = os.path.basename(appstle_export_path)
        print(
            f"Loaded {len(appstle_rows)} Appstle subscription(s) from "
            f"{source_label} (filtered {appstle_removed} internal test row(s))."
        )
        snapshot_payload = {
            "captured_at": generated_at,
            "source_file": source_label,
            "subscriptions": appstle_rows,
        }
        appstle_csv.SNAPSHOT_PATH.write_text(json.dumps(snapshot_payload, default=str, indent=2), encoding="utf-8")
        print(f"Refreshed {appstle_csv.SNAPSHOT_PATH.name} — commit this so CI (no raw CSV access) can use it too.")
    elif appstle_csv.SNAPSHOT_PATH.exists():
        # No raw CSV here (the normal CI case: the CSV is gitignored and
        # never leaves Mikael's machine) — fall back to whatever snapshot
        # was last committed. Its own captured_at is what tells the UI how
        # stale this cross-check is, not this run's generated_at.
        snapshot_payload = json.loads(appstle_csv.SNAPSHOT_PATH.read_text(encoding="utf-8"))
        appstle_rows = snapshot_payload["subscriptions"]
        source_label = snapshot_payload["source_file"]
        print(f"No raw Appstle CSV found — reusing committed snapshot ({len(appstle_rows)} subscriptions, captured {snapshot_payload['captured_at']}).")
    else:
        appstle_rows = []
        source_label = None
        snapshot_payload = {"captured_at": None}
        print("No Appstle CSV or snapshot available — Shopify-only inference used for all contracts.")

    appstle_payload = {
        "generated_at": generated_at,
        "captured_at": snapshot_payload.get("captured_at"),
        "source_file": source_label,
        "subscriptions": appstle_rows,
    }
    (EXPORT_DIR / "appstle_subscriptions.json").write_text(json.dumps(appstle_payload, default=str), encoding="utf-8")

    elapsed = time.monotonic() - started
    print(f"Exported orders.json ({len(order_rows)} orders), customers.json ({len(customer_rows)} customers).")
    print(f"Products found: {products}")
    print(f"Done in {elapsed:.1f}s")


if __name__ == "__main__":
    main()
