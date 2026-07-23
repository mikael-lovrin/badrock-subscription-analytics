"""
ETL entrypoint: pull -> load -> compute -> export.

Run manually with:  python run.py
Run in CI: the hourly GitHub Actions workflow calls this exact script.

Deliberately stateless (see the "Stateless, full-refresh ETL" note in the
project plan): every run builds a brand-new scratch SQLite database from a
full pull of both APIs, computes metrics against it, writes the JSON
export, then discards the database. Nothing persists between runs.
"""
from __future__ import annotations

import time

import db
import load
from appstle_client import AppstleClient
from config import (
    EXPORT_DIR,
    SCRATCH_DB_PATH,
    load_appstle_config,
    load_shopify_config,
)
from export import export_all
from shopify_client import ShopifyClient


def main() -> None:
    started = time.monotonic()

    shopify = ShopifyClient(load_shopify_config())
    appstle = AppstleClient(load_appstle_config())

    print("Pulling Shopify orders...")
    order_nodes = list(shopify.iter_orders())
    print(f"  {len(order_nodes)} orders")

    print("Pulling Shopify customers...")
    customer_nodes = list(shopify.iter_customers())
    print(f"  {len(customer_nodes)} customers")

    print("Pulling Appstle subscription contracts...")
    contract_nodes = list(appstle.iter_contracts())
    print(f"  {len(contract_nodes)} contracts")

    print("Pulling Appstle billing attempts (looped per status)...")
    billing_attempt_nodes = list(appstle.iter_billing_attempts())
    print(f"  {len(billing_attempt_nodes)} billing attempts")

    print("Building scratch database...")
    conn = db.build_fresh_db(SCRATCH_DB_PATH)

    order_rows, line_item_rows = load.orders_and_line_items_from_shopify(order_nodes)
    db.insert_many(conn, "orders", order_rows)
    db.insert_many(conn, "order_line_items", line_item_rows)

    customer_rows = load.customers_from_shopify(customer_nodes)
    db.insert_many(conn, "customers", customer_rows)

    contract_rows = load.subscription_contracts_from_appstle(contract_nodes)
    contract_rows = load.enrich_contracts_with_ltv(contract_rows, billing_attempt_nodes)
    db.insert_many(conn, "subscription_contracts", contract_rows)

    billing_attempt_rows = load.billing_attempts_from_appstle(billing_attempt_nodes)
    db.insert_many(conn, "subscription_billing_attempts", billing_attempt_rows)

    print("Computing metrics and exporting JSON...")
    export_all(conn, EXPORT_DIR)

    conn.close()
    SCRATCH_DB_PATH.unlink(missing_ok=True)

    elapsed = time.monotonic() - started
    print(f"Done in {elapsed:.1f}s")


if __name__ == "__main__":
    main()
