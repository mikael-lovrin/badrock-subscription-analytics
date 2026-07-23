"""
Subscription lifecycle metrics — the core deliverable of this rebuild.

Everything here is derived from two tables populated from the Appstle
Subscription Admin API (see etl/appstle_client.py + etl/load.py):

- subscription_contracts: one row per subscriber, current snapshot
  (status, plan, cancelled_on, Appstle's own lifetime_value).
- subscription_billing_attempts: an append-only ledger of every renewal
  attempt per contract. This is what lets us derive a *cycle number* per
  contract (1st renewal, 2nd renewal, ...) — something the old dashboard
  never had, because it only ever saw order line items, not a billing
  history.

All monetary figures are USD. All "month" buckets are calendar months in
UTC (the underlying timestamps from both Shopify and Appstle are UTC).
"""
from __future__ import annotations

import sqlite3
from collections import defaultdict
from datetime import datetime

# Badrock's three subscription plans, all on a MONTH billing interval unit
# distinguished only by interval count. If a new plan is ever added on a
# different interval unit (e.g. weekly), _normalize_to_monthly() below
# still produces a correct monthly-equivalent rate for it automatically —
# only this display-label map would need a new entry.
_PLAN_LABELS = {
    ("MONTH", 1): "monthly",
    ("MONTH", 2): "bimonthly",
    ("MONTH", 3): "trimonthly",
}


def plan_label(interval: str | None, interval_count: int | None) -> str:
    if interval is None or interval_count is None:
        return "unknown"
    return _PLAN_LABELS.get((interval, interval_count), f"{interval_count}x {interval.lower()}")


def _normalize_to_monthly(order_amount: float, interval: str | None, interval_count: int | None) -> float:
    """Converts a per-billing-cycle charge into its monthly-equivalent rate."""
    if not interval or not interval_count:
        return 0.0
    months_per_cycle = {
        "DAY": interval_count / 30.44,
        "WEEK": interval_count / 4.345,
        "MONTH": interval_count,
        "YEAR": interval_count * 12,
    }.get(interval)
    if not months_per_cycle:
        return 0.0
    return order_amount / months_per_cycle


def _month_key(iso_timestamp: str | None) -> str | None:
    if not iso_timestamp:
        return None
    return iso_timestamp[:7]  # "YYYY-MM-DDTHH:..." -> "YYYY-MM"


def _rows(conn: sqlite3.Connection, sql: str, params: tuple = ()) -> list[dict]:
    conn.row_factory = sqlite3.Row
    return [dict(r) for r in conn.execute(sql, params).fetchall()]


# ---------------------------------------------------------------------------
# MRR
# ---------------------------------------------------------------------------

def compute_mrr(conn: sqlite3.Connection) -> dict:
    """Current MRR from ACTIVE contracts only, normalized to a monthly rate
    per contract, summed overall and broken out by plan."""
    active = _rows(
        conn,
        """
        SELECT order_amount, billing_interval, billing_interval_count
        FROM subscription_contracts
        WHERE status = 'ACTIVE'
        """,
    )

    by_plan: dict[str, dict] = defaultdict(lambda: {"active_subscribers": 0, "mrr": 0.0})
    total_mrr = 0.0

    for c in active:
        monthly = _normalize_to_monthly(
            c["order_amount"] or 0.0, c["billing_interval"], c["billing_interval_count"]
        )
        label = plan_label(c["billing_interval"], c["billing_interval_count"])
        by_plan[label]["active_subscribers"] += 1
        by_plan[label]["mrr"] += monthly
        total_mrr += monthly

    return {
        "total_mrr": round(total_mrr, 2),
        "total_active_subscribers": len(active),
        "by_plan": {k: {"active_subscribers": v["active_subscribers"], "mrr": round(v["mrr"], 2)} for k, v in by_plan.items()},
    }


# ---------------------------------------------------------------------------
# Cycle ledger — the shared building block for churn-by-cycle and cohorts.
# ---------------------------------------------------------------------------

def _build_cycle_ledger(conn: sqlite3.Connection) -> dict[str, list[dict]]:
    """
    Returns {contract_id: [successful billing attempts, ordered by
    billing_date ascending]} — index+1 within each list is that contract's
    cycle number for that attempt.
    """
    attempts = _rows(
        conn,
        """
        SELECT contract_id, billing_date, order_amount
        FROM subscription_billing_attempts
        WHERE status = 'SUCCESS' AND billing_date IS NOT NULL
        ORDER BY contract_id, billing_date ASC
        """,
    )
    ledger: dict[str, list[dict]] = defaultdict(list)
    for a in attempts:
        ledger[a["contract_id"]].append(a)
    return ledger


# ---------------------------------------------------------------------------
# Churn by renewal cycle
# ---------------------------------------------------------------------------

def compute_churn_by_cycle(conn: sqlite3.Connection, max_cycle: int = 12) -> list[dict]:
    """
    For each renewal cycle N: how many contracts reached cycle N, and of
    those, how many never made it to cycle N+1 because they cancelled
    (their most recent successful cycle is N and their status is
    CANCELLED). This directly answers "how many cancelled at renewal cycle
    1, cycle 2, etc."
    """
    contracts = {
        c["contract_id"]: c["status"]
        for c in _rows(conn, "SELECT contract_id, status FROM subscription_contracts")
    }
    ledger = _build_cycle_ledger(conn)

    results = []
    for cycle_n in range(1, max_cycle + 1):
        reached = [cid for cid, cycles in ledger.items() if len(cycles) >= cycle_n]
        # Churned exactly at this cycle: this was their last successful
        # cycle so far, and the contract is now CANCELLED. (A contract that
        # reached cycle N, is still ACTIVE, and simply hasn't hit its next
        # billing date yet is NOT counted as churned here.)
        churned_here = [
            cid
            for cid in reached
            if len(ledger[cid]) == cycle_n and contracts.get(cid) == "CANCELLED"
        ]
        if not reached:
            continue
        results.append(
            {
                "cycle": cycle_n,
                "reached_cycle": len(reached),
                "cancelled_at_this_cycle": len(churned_here),
                "churn_rate_pct": round(100 * len(churned_here) / len(reached), 2),
            }
        )
    return results


# ---------------------------------------------------------------------------
# Monthly churn rate
# ---------------------------------------------------------------------------

def compute_monthly_churn(conn: sqlite3.Connection) -> list[dict]:
    """
    Calendar-month churn: for each month, (# contracts cancelled that
    month) / (# contracts that were active at the start of that month).
    Complementary to compute_churn_by_cycle() — this is "churn mês a mês"
    on the calendar, not per renewal.
    """
    contracts = _rows(
        conn,
        "SELECT contract_id, status, created_at, cancelled_on FROM subscription_contracts",
    )
    if not contracts:
        return []

    months = sorted(
        {_month_key(c["created_at"]) for c in contracts if c["created_at"]}
        | {_month_key(c["cancelled_on"]) for c in contracts if c["cancelled_on"]}
    )

    results = []
    for month in months:
        month_start = f"{month}-01"
        active_at_start = 0
        cancelled_this_month = 0
        for c in contracts:
            created = c["created_at"]
            cancelled = c["cancelled_on"]
            if not created or created[:10] >= month_start:
                continue  # not yet created at the start of this month
            was_active_at_start = cancelled is None or cancelled[:10] >= month_start
            if was_active_at_start:
                active_at_start += 1
                if cancelled and _month_key(cancelled) == month:
                    cancelled_this_month += 1
        churn_rate = round(100 * cancelled_this_month / active_at_start, 2) if active_at_start else 0.0
        results.append(
            {
                "month": month,
                "active_at_start": active_at_start,
                "cancelled": cancelled_this_month,
                "churn_rate_pct": churn_rate,
            }
        )
    return results


# ---------------------------------------------------------------------------
# Cohort retention matrix
# ---------------------------------------------------------------------------

def compute_cohort_retention(conn: sqlite3.Connection, max_cycle: int = 12) -> list[dict]:
    """
    Groups contracts by acquisition month (created_at truncated to month)
    and plan, then reports what % of that cohort reached each renewal
    cycle. Standard SaaS retention-curve shape, split by plan since a
    "cycle" spans a different number of calendar days per plan.
    """
    contracts = _rows(
        conn,
        """
        SELECT contract_id, created_at, billing_interval, billing_interval_count
        FROM subscription_contracts
        """,
    )
    ledger = _build_cycle_ledger(conn)

    cohorts: dict[tuple[str, str], list[str]] = defaultdict(list)
    for c in contracts:
        month = _month_key(c["created_at"])
        if month is None:
            continue
        plan = plan_label(c["billing_interval"], c["billing_interval_count"])
        cohorts[(month, plan)].append(c["contract_id"])

    results = []
    for (month, plan), contract_ids in sorted(cohorts.items()):
        cohort_size = len(contract_ids)
        retention_by_cycle = {}
        for cycle_n in range(1, max_cycle + 1):
            reached = sum(1 for cid in contract_ids if len(ledger.get(cid, [])) >= cycle_n)
            if reached == 0:
                break
            retention_by_cycle[cycle_n] = round(100 * reached / cohort_size, 2)
        results.append(
            {
                "cohort_month": month,
                "plan": plan,
                "cohort_size": cohort_size,
                "retention_by_cycle_pct": retention_by_cycle,
            }
        )
    return results


# ---------------------------------------------------------------------------
# LTV
# ---------------------------------------------------------------------------

def compute_ltv(conn: sqlite3.Connection) -> dict:
    """
    Uses Appstle's own lifetime_value_usd per contract (computed by Appstle
    from actual billing history) rather than re-deriving an estimate.
    Reported as a current snapshot — explicitly not a converged/final
    number, since it will keep rising until every contract in a cohort has
    eventually cancelled.
    """
    contracts = _rows(
        conn,
        """
        SELECT lifetime_value_usd, billing_interval, billing_interval_count, status
        FROM subscription_contracts
        WHERE lifetime_value_usd IS NOT NULL
        """,
    )
    if not contracts:
        return {"overall_avg_ltv": 0.0, "by_plan": {}, "sample_size": 0}

    overall_avg = sum(c["lifetime_value_usd"] for c in contracts) / len(contracts)

    by_plan: dict[str, list[float]] = defaultdict(list)
    for c in contracts:
        label = plan_label(c["billing_interval"], c["billing_interval_count"])
        by_plan[label].append(c["lifetime_value_usd"])

    return {
        "overall_avg_ltv": round(overall_avg, 2),
        "sample_size": len(contracts),
        "by_plan": {
            label: {"avg_ltv": round(sum(values) / len(values), 2), "sample_size": len(values)}
            for label, values in by_plan.items()
        },
    }


# ---------------------------------------------------------------------------
# Average subscriber lifespan (churned contracts only — the ones we can
# actually measure a completed lifespan for)
# ---------------------------------------------------------------------------

def compute_average_lifespan(conn: sqlite3.Connection) -> dict:
    cancelled = _rows(
        conn,
        """
        SELECT created_at, cancelled_on, billing_interval, billing_interval_count
        FROM subscription_contracts
        WHERE status = 'CANCELLED' AND created_at IS NOT NULL AND cancelled_on IS NOT NULL
        """,
    )
    if not cancelled:
        return {"avg_lifespan_days": None, "sample_size": 0, "by_plan": {}}

    def _days(row) -> float:
        start = datetime.fromisoformat(row["created_at"].replace("Z", "+00:00"))
        end = datetime.fromisoformat(row["cancelled_on"].replace("Z", "+00:00"))
        return (end - start).total_seconds() / 86400

    by_plan: dict[str, list[float]] = defaultdict(list)
    all_days = []
    for c in cancelled:
        days = _days(c)
        all_days.append(days)
        by_plan[plan_label(c["billing_interval"], c["billing_interval_count"])].append(days)

    return {
        "avg_lifespan_days": round(sum(all_days) / len(all_days), 1),
        "sample_size": len(all_days),
        "by_plan": {
            label: {"avg_lifespan_days": round(sum(v) / len(v), 1), "sample_size": len(v)}
            for label, v in by_plan.items()
        },
    }


# ---------------------------------------------------------------------------
# Plan mix summary — one-stop comparison table across the three plans.
# ---------------------------------------------------------------------------

def compute_plan_mix(conn: sqlite3.Connection) -> list[dict]:
    contracts = _rows(
        conn,
        """
        SELECT status, billing_interval, billing_interval_count, lifetime_value_usd
        FROM subscription_contracts
        """,
    )
    by_plan: dict[str, dict] = defaultdict(lambda: {"total": 0, "active": 0, "cancelled": 0, "ltv_values": []})
    for c in contracts:
        label = plan_label(c["billing_interval"], c["billing_interval_count"])
        bucket = by_plan[label]
        bucket["total"] += 1
        if c["status"] == "ACTIVE":
            bucket["active"] += 1
        elif c["status"] == "CANCELLED":
            bucket["cancelled"] += 1
        if c["lifetime_value_usd"] is not None:
            bucket["ltv_values"].append(c["lifetime_value_usd"])

    results = []
    for label, bucket in sorted(by_plan.items()):
        ltv_values = bucket["ltv_values"]
        results.append(
            {
                "plan": label,
                "total_subscribers": bucket["total"],
                "active_subscribers": bucket["active"],
                "cancelled_subscribers": bucket["cancelled"],
                "cancellation_rate_pct": round(100 * bucket["cancelled"] / bucket["total"], 2) if bucket["total"] else 0.0,
                "avg_ltv": round(sum(ltv_values) / len(ltv_values), 2) if ltv_values else None,
            }
        )
    return results


def compute_all(conn: sqlite3.Connection) -> dict:
    """Single entrypoint export.py calls to assemble the full subscriptions.json payload."""
    return {
        "mrr": compute_mrr(conn),
        "churn_by_cycle": compute_churn_by_cycle(conn),
        "monthly_churn": compute_monthly_churn(conn),
        "cohort_retention": compute_cohort_retention(conn),
        "ltv": compute_ltv(conn),
        "average_lifespan": compute_average_lifespan(conn),
        "plan_mix": compute_plan_mix(conn),
    }
