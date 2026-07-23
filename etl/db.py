"""
Scratch SQLite database: schema + bulk writers.

This database is rebuilt from scratch on every ETL run and discarded once
etl/export.py has written the JSON output (see etl/run.py) — it exists only
to give the metrics layer a convenient SQL surface to query against, not as
a persistent store. That's why every insert here is a plain INSERT (no
upsert/conflict handling needed): each run starts from an empty file.
"""
from __future__ import annotations

import sqlite3
from pathlib import Path

_SCHEMA = """
CREATE TABLE customers (
    id           TEXT PRIMARY KEY,
    email        TEXT,
    first_name   TEXT,
    last_name    TEXT,
    created_at   TEXT,
    orders_count INTEGER,
    total_spent  REAL,
    city         TEXT,
    province     TEXT,
    country      TEXT
);

CREATE TABLE orders (
    id                TEXT PRIMARY KEY,
    order_name        TEXT,
    created_at        TEXT,
    customer_id       TEXT,
    email             TEXT,
    total_price       REAL,
    financial_status  TEXT,
    city              TEXT,
    province          TEXT,
    country           TEXT
);

CREATE TABLE order_line_items (
    id       TEXT PRIMARY KEY,
    order_id TEXT REFERENCES orders(id),
    title    TEXT,
    quantity INTEGER,
    price    REAL
);

-- One row per subscriber (Appstle subscription-contract-details).
-- billing_interval / billing_interval_count together define the plan:
-- MONTH x1 = monthly ($49), MONTH x2 = bimonthly ($88), MONTH x3 = trimonthly ($117).
CREATE TABLE subscription_contracts (
    contract_id            TEXT PRIMARY KEY,
    customer_id            TEXT,
    customer_email         TEXT,
    status                 TEXT,
    billing_interval       TEXT,
    billing_interval_count INTEGER,
    created_at             TEXT,
    activated_on           TEXT,
    cancelled_on           TEXT,
    next_billing_date      TEXT,
    order_amount           REAL,
    currency               TEXT,
    min_cycles             INTEGER,
    max_cycles             INTEGER,
    total_successful_orders INTEGER,
    lifetime_value         REAL,
    lifetime_value_usd     REAL
);

-- Append-only renewal ledger (Appstle billing-attempts past-orders report).
-- Cohort/churn-by-cycle math is derived entirely from this table: order a
-- contract's SUCCESS rows by billing_date to get its cycle sequence.
CREATE TABLE subscription_billing_attempts (
    attempt_id    TEXT PRIMARY KEY,
    contract_id   TEXT REFERENCES subscription_contracts(contract_id),
    order_id      TEXT,
    order_name    TEXT,
    status        TEXT,
    billing_date  TEXT,
    attempt_time  TEXT,
    order_amount  REAL,
    attempt_count INTEGER
);

CREATE INDEX idx_orders_customer_id ON orders(customer_id);
CREATE INDEX idx_line_items_order_id ON order_line_items(order_id);
CREATE INDEX idx_contracts_customer_id ON subscription_contracts(customer_id);
CREATE INDEX idx_attempts_contract_id ON subscription_billing_attempts(contract_id);
CREATE INDEX idx_attempts_billing_date ON subscription_billing_attempts(billing_date);
"""


def build_fresh_db(db_path: Path) -> sqlite3.Connection:
    """Deletes any leftover file at db_path and creates a clean schema."""
    db_path.unlink(missing_ok=True)
    conn = sqlite3.connect(db_path)
    conn.executescript(_SCHEMA)
    conn.commit()
    return conn


def insert_many(conn: sqlite3.Connection, table: str, rows: list[dict]) -> None:
    """Bulk-inserts a list of same-shaped row dicts into `table`."""
    if not rows:
        return
    columns = list(rows[0].keys())
    placeholders = ", ".join("?" * len(columns))
    sql = f"INSERT INTO {table} ({', '.join(columns)}) VALUES ({placeholders})"
    conn.executemany(sql, [[row[c] for c in columns] for row in rows])
    conn.commit()
