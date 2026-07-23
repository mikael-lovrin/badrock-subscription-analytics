"""
Customer-intelligence metrics — new vs returning, acquisition trend.
Powers the Customer Intelligence page.
"""
from __future__ import annotations

import sqlite3


def _rows(conn: sqlite3.Connection, sql: str, params: tuple = ()) -> list[dict]:
    conn.row_factory = sqlite3.Row
    return [dict(r) for r in conn.execute(sql, params).fetchall()]


def compute_new_vs_returning(conn: sqlite3.Connection) -> dict:
    """
    Splits every non-voided order into "new" (this is the customer's first
    order ever) vs "returning", using each customer's earliest order date
    as the cutoff.
    """
    rows = _rows(
        conn,
        """
        WITH first_orders AS (
            SELECT customer_id, MIN(created_at) AS first_order_at
            FROM orders
            WHERE financial_status != 'VOIDED' AND customer_id IS NOT NULL
            GROUP BY customer_id
        )
        SELECT o.id,
               CASE WHEN o.created_at = f.first_order_at THEN 'new' ELSE 'returning' END AS segment,
               o.total_price
        FROM orders o
        JOIN first_orders f ON f.customer_id = o.customer_id
        WHERE o.financial_status != 'VOIDED'
        """,
    )
    new_orders = [r for r in rows if r["segment"] == "new"]
    returning_orders = [r for r in rows if r["segment"] == "returning"]
    return {
        "new_orders": len(new_orders),
        "new_revenue": round(sum(r["total_price"] for r in new_orders), 2),
        "returning_orders": len(returning_orders),
        "returning_revenue": round(sum(r["total_price"] for r in returning_orders), 2),
    }


def compute_acquisition_trend(conn: sqlite3.Connection) -> list[dict]:
    return _rows(
        conn,
        """
        WITH first_orders AS (
            SELECT customer_id, MIN(created_at) AS first_order_at
            FROM orders
            WHERE financial_status != 'VOIDED' AND customer_id IS NOT NULL
            GROUP BY customer_id
        )
        SELECT substr(first_order_at, 1, 10) AS date, COUNT(*) AS new_customers
        FROM first_orders
        GROUP BY date
        ORDER BY date ASC
        """,
    )


def compute_all(conn: sqlite3.Connection) -> dict:
    return {
        "new_vs_returning": compute_new_vs_returning(conn),
        "acquisition_trend": compute_acquisition_trend(conn),
    }
