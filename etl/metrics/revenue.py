"""
Order/revenue/product metrics — powers the Overview and Products & Upsell
pages. Ported from the old Streamlit tool's metrics.py, with the previously
unused has_subscription/is_subscription columns dropped (see etl/db.py) and
the flawed window-proxy MRR/LTV functions removed entirely — that logic now
lives in metrics/subscriptions.py, backed by real Appstle data.

Product tagging convention (from the Badrock catalog):
  [R]  recurring / subscription variant
  [OT] one-time-purchase variant
  [U1] post-purchase upsell (never recurring)
"""
from __future__ import annotations

import sqlite3
from collections import defaultdict


def _rows(conn: sqlite3.Connection, sql: str, params: tuple = ()) -> list[dict]:
    conn.row_factory = sqlite3.Row
    return [dict(r) for r in conn.execute(sql, params).fetchall()]


def _is_subscription_title(title: str) -> bool:
    return "[r]" in title.lower()


def _is_upsell_title(title: str) -> bool:
    return "[u1]" in title.lower()


def compute_summary(conn: sqlite3.Connection) -> dict:
    orders = _rows(
        conn,
        "SELECT id, total_price, customer_id FROM orders WHERE financial_status != 'VOIDED'",
    )
    line_items = _rows(
        conn,
        """
        SELECT li.order_id, li.title
        FROM order_line_items li
        JOIN orders o ON o.id = li.order_id
        WHERE o.financial_status != 'VOIDED'
        """,
    )
    sub_order_ids = {li["order_id"] for li in line_items if _is_subscription_title(li["title"])}

    total_orders = len(orders)
    total_revenue = sum(o["total_price"] for o in orders)
    unique_customers = len({o["customer_id"] for o in orders if o["customer_id"]})

    return {
        "total_orders": total_orders,
        "total_revenue": round(total_revenue, 2),
        "aov": round(total_revenue / total_orders, 2) if total_orders else 0.0,
        "unique_customers": unique_customers,
        "subscription_order_rate_pct": round(100 * len(sub_order_ids) / total_orders, 2) if total_orders else 0.0,
    }


def compute_revenue_trend(conn: sqlite3.Connection) -> list[dict]:
    return _rows(
        conn,
        """
        SELECT substr(created_at, 1, 10) AS date, COUNT(*) AS orders, SUM(total_price) AS revenue
        FROM orders
        WHERE financial_status != 'VOIDED'
        GROUP BY date
        ORDER BY date ASC
        """,
    )


def compute_top_products(conn: sqlite3.Connection, limit: int = 20) -> list[dict]:
    return _rows(
        conn,
        """
        SELECT li.title,
               SUM(li.quantity) AS units,
               COUNT(DISTINCT li.order_id) AS orders,
               SUM(li.price * li.quantity) AS revenue,
               AVG(li.price) AS avg_price
        FROM order_line_items li
        JOIN orders o ON o.id = li.order_id
        WHERE o.financial_status != 'VOIDED'
        GROUP BY li.title
        ORDER BY revenue DESC
        LIMIT ?
        """,
        (limit,),
    )


def compute_upsell_attach_rate(conn: sqlite3.Connection) -> dict:
    line_items = _rows(
        conn,
        """
        SELECT li.order_id, li.title
        FROM order_line_items li
        JOIN orders o ON o.id = li.order_id
        WHERE o.financial_status != 'VOIDED'
        """,
    )
    orders_with_upsell = {li["order_id"] for li in line_items if _is_upsell_title(li["title"])}
    all_orders = {li["order_id"] for li in line_items}
    return {
        "orders_with_upsell": len(orders_with_upsell),
        "total_orders": len(all_orders),
        "attach_rate_pct": round(100 * len(orders_with_upsell) / len(all_orders), 2) if all_orders else 0.0,
    }


def compute_revenue_by_geo(conn: sqlite3.Connection) -> dict:
    return {
        "by_country": _rows(
            conn,
            """
            SELECT country, COUNT(*) AS orders, SUM(total_price) AS revenue
            FROM orders WHERE financial_status != 'VOIDED' AND country IS NOT NULL
            GROUP BY country ORDER BY revenue DESC
            """,
        ),
        "by_province": _rows(
            conn,
            """
            SELECT province, COUNT(*) AS orders, SUM(total_price) AS revenue
            FROM orders WHERE financial_status != 'VOIDED' AND province IS NOT NULL
            GROUP BY province ORDER BY revenue DESC
            """,
        ),
    }


def compute_all(conn: sqlite3.Connection) -> dict:
    return {
        "summary": compute_summary(conn),
        "revenue_trend": compute_revenue_trend(conn),
        "top_products": compute_top_products(conn),
        "upsell_attach_rate": compute_upsell_attach_rate(conn),
        "revenue_by_geo": compute_revenue_by_geo(conn),
    }
