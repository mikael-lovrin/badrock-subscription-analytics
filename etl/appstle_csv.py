"""
Parses a manually-exported Appstle subscription CSV into the same clean row
shape the site consumes. Manual because Badrock's Appstle plan doesn't
include API access (see load.py's module docstring) — Mikael exports this
CSV from the Appstle dashboard himself and drops it in manual-exports/.

That raw CSV is gitignored (it carries phone/address/payment PII the site
never otherwise exposes) and therefore invisible to CI. So there are two
paths, both driven from run.py:
  - Locally, whenever a fresh CSV is sitting in manual-exports/, it gets
    parsed straight and also written out to SNAPSHOT_PATH — a small,
    PII-trimmed (email + subscription status only, same fields the site's
    JSON exports already carry elsewhere) snapshot that's safe to commit.
  - In CI (no raw CSV, since it never left Mikael's machine), run.py falls
    back to reading whatever snapshot was last committed. It only gets
    fresher when Mikael reruns locally with a new export and commits the
    updated snapshot — there's no way to automate the export itself
    without Appstle API access.

Confirmed 2026-07-31: this ledger is real ground truth for subscription
status, unlike the Shopify-order-silence inference in metricsEngine.ts's
buildContracts() — cross-checking the first export against the site's
inferred numbers found 44 real cancellations vs. 17 inferred (many
subscribers cancel proactively, days before our grace-period heuristic
would ever have caught it). See buildContracts() for how the two get
reconciled: Appstle status wins wherever a row can be matched to a
contract, the Shopify inference is only a fallback for unmatched ones.
"""
from __future__ import annotations

import csv
import glob
import os
from pathlib import Path
from typing import Any

from load import _PRODUCT_ALIASES, is_test_order

MANUAL_EXPORTS_DIR = os.path.join(os.path.dirname(__file__), "manual-exports")

# Small, PII-trimmed, git-tracked cross-check of the raw CSV — see module
# docstring for why this (and not the raw CSV) is what CI actually reads.
SNAPSHOT_PATH = Path(__file__).resolve().parent / "appstle_snapshot.json"


def _extract_product_from_line_title(title: str) -> str | None:
    """Appstle's "Line title" looks like "Beef Organ Complex - [R] - 2 Pack
    - [F]" — same [TAG] convention as Shopify line-item titles, so this
    reuses the exact same alias map as load.py's extract_product_name()
    rather than duplicating/drifting from it."""
    if not title:
        return None
    for separator in (" - [", " ["):
        idx = title.find(separator)
        if idx != -1:
            name = title[:idx].strip()
            return _PRODUCT_ALIASES.get(name, name)
    return None


def find_latest_export() -> str | None:
    """Picks the most recently exported CSV in manual-exports/ by
    filename — Appstle's own export filenames end in a sortable timestamp
    (SUBSCRIPTION_export_<YYYYMMDDHHMMSSmmm>.csv), so lexicographic max is
    chronological max. Returns None if no CSV has ever been dropped there
    (a fresh clone, or a Badrock brand that doesn't use Appstle) — callers
    must treat that as "no Appstle data available", not an error."""
    candidates = sorted(glob.glob(os.path.join(MANUAL_EXPORTS_DIR, "*.csv")))
    return candidates[-1] if candidates else None


def _parse_int(value: str) -> int | None:
    value = (value or "").strip()
    return int(value) if value.isdigit() else None


def _parse_float(value: str) -> float:
    value = (value or "").strip()
    try:
        return float(value)
    except ValueError:
        return 0.0


def _parse_interval_months(interval_type: str, interval_count: str) -> int | None:
    # Every row observed so far uses "MONTH" as the interval type (monthly/
    # bimonthly/trimonthly all expressed as a MONTH count of 1/2/3) — if a
    # WEEK/YEAR interval ever shows up this returns None rather than
    # guessing, and callers fall back to the Shopify-inferred interval.
    if (interval_type or "").strip().upper() != "MONTH":
        return None
    return _parse_int(interval_count)


def load_appstle_subscriptions(path: str) -> tuple[list[dict[str, Any]], int]:
    """Returns (subscription_rows, test_rows_removed_count)."""
    rows: list[dict[str, Any]] = []
    removed = 0

    with open(path, encoding="utf-8-sig", newline="") as f:
        for raw in csv.DictReader(f):
            email = (raw.get("Customer email") or "").strip()
            full_name = (raw.get("Customer name") or "").strip()
            first, _, last = full_name.partition(" ")
            revenue = _parse_float(raw.get("Total revenue generated (USD)", ""))

            if is_test_order(revenue, email, first, last):
                removed += 1
                continue

            status = (raw.get("Status") or "").strip().lower()
            cancellation_reason = (raw.get("Cancellation reason") or raw.get("cancellation Reason") or "").strip() or None
            cancellation_note = (raw.get("Cancellation note") or raw.get("cancellation note") or "").strip() or None

            rows.append(
                {
                    "id": (raw.get("ID") or "").strip(),
                    "customer_email": email.lower(),
                    "status": status,
                    "product": _extract_product_from_line_title(raw.get("Line title", "")),
                    "created_at": (raw.get("Created at") or "").strip() or None,
                    "next_order_date": (raw.get("Next order date") or "").strip() or None,
                    "interval_months": _parse_interval_months(
                        raw.get("Billing interval type", ""), raw.get("Billing interval count", "")
                    ),
                    "cancellation_date": (raw.get("Cancellation date") or "").strip() or None,
                    "cancellation_reason": cancellation_reason,
                    "cancellation_note": cancellation_note,
                    "paused_on_date": (raw.get("Paused on date") or "").strip() or None,
                    "cycles": _parse_int(raw.get("Total orders till date / Current Billing cycle", "")),
                    "total_revenue": revenue,
                    "first_order_name": (raw.get("First order name") or "").strip() or None,
                    "last_order_name": (raw.get("Last order name") or "").strip() or None,
                    "last_order_date": (raw.get("Last order date") or "").strip() or None,
                }
            )

    return rows, removed
