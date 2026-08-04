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

    order_rows, line_item_rows, removed_count, dewlyte_orders_removed, dewlyte_order_emails = (
        load.orders_and_line_items_from_shopify(order_nodes)
    )
    print(f"Filtered out {removed_count} internal test order(s), kept {len(order_rows)}.")
    if dewlyte_orders_removed:
        print(
            f"Filtered out {dewlyte_orders_removed} Dewlyte order(s) — different FEG-group brand, "
            "out of scope for this Badrock analytics tool (see load.py's _EXCLUDED_PRODUCTS)."
        )

    customer_rows = load.customers_from_shopify(customer_nodes)
    # A customer whose email never shows up on any KEPT (non-Dewlyte) order
    # is a Dewlyte-only customer in this dataset — drop them from
    # customers.json too. Limitation: Shopify order history here is capped
    # at 60 days (see README) unless read_all_orders is enabled, so a
    # customer whose only-ever purchase was Dewlyte further back than that
    # window won't be caught by this and will still show up.
    kept_order_emails = {(o["email"] or "").strip().lower() for o in order_rows if o.get("email")}
    dewlyte_only_emails = dewlyte_order_emails - kept_order_emails
    if dewlyte_only_emails:
        before = len(customer_rows)
        customer_rows = [c for c in customer_rows if (c.get("email") or "").strip().lower() not in dewlyte_only_emails]
        print(f"Filtered out {before - len(customer_rows)} Dewlyte-only customer(s) from customers.json.")

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
        appstle_rows, appstle_removed, appstle_dewlyte_removed = appstle_csv.load_appstle_subscriptions(
            appstle_export_path
        )
        source_label = os.path.basename(appstle_export_path)
        print(
            f"Loaded {len(appstle_rows)} Appstle subscription(s) from "
            f"{source_label} (filtered {appstle_removed} internal test row(s), "
            f"{appstle_dewlyte_removed} Dewlyte row(s))."
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

    # Defensive/uniform pass regardless of which branch above ran: catches
    # a pre-fix committed snapshot that might still carry Dewlyte rows
    # (the fresh-CSV branch already filters at parse time, so this is a
    # no-op there). See appstle_csv.excluded_product_contract_ids()'s
    # docstring — these contract ids are also needed to scrub the
    # billing-events export below, which has no product field of its own.
    dewlyte_contract_ids = appstle_csv.excluded_product_contract_ids(appstle_rows)
    if dewlyte_contract_ids:
        before = len(appstle_rows)
        appstle_rows = appstle_csv.filter_out_excluded_product_subscriptions(appstle_rows)
        print(f"Filtered out {before - len(appstle_rows)} additional Dewlyte subscription row(s) found in the loaded data.")

    appstle_payload = {
        "generated_at": generated_at,
        "captured_at": snapshot_payload.get("captured_at"),
        "source_file": source_label,
        "subscriptions": appstle_rows,
    }
    (EXPORT_DIR / "appstle_subscriptions.json").write_text(json.dumps(appstle_payload, default=str), encoding="utf-8")

    # Billing-attempt exports (success/failed/skipped-dunning) — same local
    # vs. CI split as the subscription ledger above: parse fresh CSVs when
    # they're sitting in manual-exports/, otherwise fall back to the last
    # committed snapshot (CI never has the raw CSVs, since they're
    # gitignored PII).
    fresh_events, fresh_sources = appstle_csv.load_appstle_billing_events()
    if any(fresh_sources.values()):
        billing_events = fresh_events
        billing_sources = fresh_sources
        billing_captured_at = generated_at
        print(
            f"Loaded {len(billing_events)} Appstle billing-attempt row(s) "
            f"({sum(1 for e in billing_events if e['outcome'] == 'success')} success, "
            f"{sum(1 for e in billing_events if e['outcome'] == 'failed')} failed, "
            f"{sum(1 for e in billing_events if e['outcome'] == 'skipped_dunning')} skipped-dunning) "
            f"from {billing_sources}."
        )
        billing_snapshot_payload = {"captured_at": billing_captured_at, "sources": billing_sources, "events": billing_events}
        appstle_csv.BILLING_EVENTS_SNAPSHOT_PATH.write_text(
            json.dumps(billing_snapshot_payload, default=str, indent=2), encoding="utf-8"
        )
        print(f"Refreshed {appstle_csv.BILLING_EVENTS_SNAPSHOT_PATH.name} — commit this too.")
    elif appstle_csv.BILLING_EVENTS_SNAPSHOT_PATH.exists():
        billing_snapshot_payload = json.loads(appstle_csv.BILLING_EVENTS_SNAPSHOT_PATH.read_text(encoding="utf-8"))
        billing_events = billing_snapshot_payload["events"]
        billing_sources = billing_snapshot_payload["sources"]
        billing_captured_at = billing_snapshot_payload["captured_at"]
        print(f"No raw billing-attempt CSVs found — reusing committed snapshot ({len(billing_events)} rows).")
    else:
        billing_events = []
        billing_sources = {"success": None, "failed": None, "skipped_dunning": None}
        billing_captured_at = None
        print("No Appstle billing-attempt exports or snapshot available.")

    if dewlyte_contract_ids:
        before = len(billing_events)
        billing_events = appstle_csv.filter_out_excluded_product_billing_events(billing_events, dewlyte_contract_ids)
        removed_billing = before - len(billing_events)
        if removed_billing:
            print(f"Filtered out {removed_billing} Dewlyte billing-attempt row(s) (joined via contract_id).")

    billing_events_payload = {
        "generated_at": generated_at,
        "captured_at": billing_captured_at,
        "sources": billing_sources,
        "events": billing_events,
    }
    (EXPORT_DIR / "appstle_billing_events.json").write_text(
        json.dumps(billing_events_payload, default=str), encoding="utf-8"
    )

    elapsed = time.monotonic() - started
    print(f"Exported orders.json ({len(order_rows)} orders), customers.json ({len(customer_rows)} customers).")
    print(f"Products found: {products}")
    print(f"Done in {elapsed:.1f}s")


if __name__ == "__main__":
    main()
