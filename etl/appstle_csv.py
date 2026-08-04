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
import re
from pathlib import Path
from typing import Any

from load import _PRODUCT_ALIASES, is_excluded_product, is_test_order

MANUAL_EXPORTS_DIR = os.path.join(os.path.dirname(__file__), "manual-exports")

# Small, PII-trimmed, git-tracked cross-check of the raw CSV — see module
# docstring for why this (and not the raw CSV) is what CI actually reads.
SNAPSHOT_PATH = Path(__file__).resolve().parent / "appstle_snapshot.json"

# Same idea as SNAPSHOT_PATH, for the 3 newer Appstle "Analytics" exports
# (success/failed/skipped-dunning past orders) added 2026-08-04 — see
# load_appstle_billing_events() below. One combined snapshot/payload for
# all three, since they share the same row shape (one billing attempt per
# row) and the site's dunning-funnel view wants them side by side anyway.
BILLING_EVENTS_SNAPSHOT_PATH = Path(__file__).resolve().parent / "appstle_billing_events_snapshot.json"


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


def find_latest_export(prefix: str = "SUBSCRIPTION_export") -> str | None:
    """Picks the most recently exported CSV matching `prefix` in
    manual-exports/ by filename — Appstle's own export filenames end in a
    sortable timestamp (e.g. SUBSCRIPTION_export_<YYYYMMDDHHMMSSmmm>.csv,
    ANALYTICS_success_past_orders_export_<...>.csv), so lexicographic max
    is chronological max. `prefix` defaults to the main subscription
    ledger export for backward compatibility; pass one of the
    ANALYTICS_* prefixes to pick up the success/failed/skipped-dunning
    exports added 2026-08-04 (see load_appstle_billing_events()). Returns
    None if no matching CSV has ever been dropped there (a fresh clone, a
    Badrock brand that doesn't use Appstle, or simply one of the 4 export
    types Mikael hasn't pulled yet) — callers must treat that as "no data
    available for this export type", not an error."""
    candidates = sorted(glob.glob(os.path.join(MANUAL_EXPORTS_DIR, f"{prefix}*.csv")))
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


def load_appstle_subscriptions(path: str) -> tuple[list[dict[str, Any]], int, int]:
    """Returns (subscription_rows, test_rows_removed_count, excluded_product_rows_removed_count).

    The excluded-product count is Dewlyte rows dropped at parse time — see
    load.py's `_EXCLUDED_PRODUCTS`/`is_excluded_product`: Dewlyte is a
    different FEG-group brand riding this same shared Appstle setup, not a
    Badrock product, so it must never reach appstle_subscriptions.json.
    """
    rows: list[dict[str, Any]] = []
    removed = 0
    removed_excluded_product = 0

    with open(path, encoding="utf-8-sig", newline="") as f:
        for raw in csv.DictReader(f):
            email = (raw.get("Customer email") or "").strip()
            full_name = (raw.get("Customer name") or "").strip()
            first, _, last = full_name.partition(" ")
            revenue = _parse_float(raw.get("Total revenue generated (USD)", ""))

            if is_test_order(revenue, email, first, last):
                removed += 1
                continue

            product = _extract_product_from_line_title(raw.get("Line title", ""))
            if is_excluded_product(product):
                removed_excluded_product += 1
                continue

            status = (raw.get("Status") or "").strip().lower()
            cancellation_reason = (raw.get("Cancellation reason") or raw.get("cancellation Reason") or "").strip() or None
            cancellation_note = (raw.get("Cancellation note") or raw.get("cancellation note") or "").strip() or None

            rows.append(
                {
                    "id": (raw.get("ID") or "").strip(),
                    "customer_email": email.lower(),
                    "status": status,
                    "product": product,
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

    return rows, removed, removed_excluded_product


def excluded_product_contract_ids(subscription_rows: list[dict[str, Any]]) -> set[str]:
    """Given ALREADY-loaded subscription rows (fresh CSV parse or the
    committed snapshot fallback — see run.py), returns the ids of any that
    are still an excluded product (Dewlyte). Defensive/uniform pass: the
    fresh-parse path above already filters these out at the source, but an
    older, pre-fix committed snapshot could still carry Dewlyte rows until
    it's regenerated — this catches that case too, and gives run.py the
    contract ids needed to also scrub the billing-events export (which has
    no product field of its own, only contract_id)."""
    return {r["id"] for r in subscription_rows if is_excluded_product(r.get("product"))}


def filter_out_excluded_product_subscriptions(subscription_rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [r for r in subscription_rows if not is_excluded_product(r.get("product"))]


def filter_out_excluded_product_billing_events(
    events: list[dict[str, Any]], excluded_contract_ids: set[str]
) -> list[dict[str, Any]]:
    """Drops billing-attempt rows tied to an excluded-product (Dewlyte)
    contract, joined via contract_id against `excluded_contract_ids` (see
    excluded_product_contract_ids()). Note: if a Dewlyte contract isn't
    present at all in the current subscription export (these Appstle
    exports are independent, rolling-window pulls — see README), its
    billing events can't be matched here and would leak through; this is a
    best-effort join, not a guarantee, given Appstle's manual-export setup."""
    if not excluded_contract_ids:
        return events
    return [e for e in events if e.get("contract_id") not in excluded_contract_ids]


# ---------------------------------------------------------------------------
# Billing-attempt exports (success / failed / skipped-dunning) — added
# 2026-08-04 once Mikael pulled these 3 extra Appstle "Analytics" exports
# alongside the main subscription ledger. Unlike the subscription export
# (one row per contract, current state only), these are one row per
# *billing attempt* — the history the subscription export's "Cancellation
# reason" field alone can't explain (e.g. "cancelled after N failed
# retries" vs. "cancelled while current on payments"). All three share
# enough shape (contract id, customer email, a billing/attempt date, a
# running total of past successful orders) that they're normalized here
# into one common row shape, tagged by `outcome`, so the site can build a
# single failed -> skipped -> recovered/cancelled dunning funnel across all
# three instead of three separate one-off views.
#
# Confirmed 2026-08-04: only ~5-6 weeks of recent billing activity is
# present in these exports (37 success / 6 failed / 9 skipped rows total)
# — Appstle's analytics exports look like a rolling window, not full
# history, similar in spirit to the Shopify 60-day order cap (see README).
# Treat any dunning-recovery rate computed from these as directional only
# until a wider export is available.
# ---------------------------------------------------------------------------

_UTM_ATTR_RE = re.compile(r"key='([^']*)',\s*value='([^']*)'")


def _parse_utm_attributes(raw_attributes: str) -> dict[str, str]:
    """Appstle's "Attributes" column on the success-orders export is a
    Java-toString-style dump, e.g. "[AttributeInfo{key='utm_campaign',
    value='...'}, AttributeInfo{key='utm_content', value='...'}, ...]" —
    not JSON, so this regexes key/value pairs out rather than trying to
    parse it as a structured format Appstle never actually emits."""
    if not raw_attributes:
        return {}
    return {key: value for key, value in _UTM_ATTR_RE.findall(raw_attributes)}


def _billing_event_row(
    *,
    contract_id: str,
    customer_email: str,
    outcome: str,
    billing_date: str | None,
    attempt_number: int | None,
    error_code: str | None,
    error_message: str | None,
    total_successful_orders: int | None,
    last_successful_order_name: str | None,
    last_successful_order_date: str | None,
    order_amount: float | None,
    utm: dict[str, str],
) -> dict[str, Any]:
    return {
        "contract_id": contract_id,
        "customer_email": customer_email.lower(),
        "outcome": outcome,  # "success" | "failed" | "skipped_dunning"
        "billing_date": billing_date,
        "attempt_number": attempt_number,
        "error_code": error_code,
        "error_message": error_message,
        "total_successful_orders": total_successful_orders,
        "last_successful_order_name": last_successful_order_name,
        "last_successful_order_date": last_successful_order_date,
        "order_amount": order_amount,
        "utm_campaign": utm.get("utm_campaign") or None,
        "utm_content": utm.get("utm_content") or None,
        "utm_medium": utm.get("utm_medium") or None,
    }


def load_appstle_success_orders(path: str) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    with open(path, encoding="utf-8-sig", newline="") as f:
        for raw in csv.DictReader(f):
            utm = _parse_utm_attributes(raw.get("Attributes", ""))
            rows.append(
                _billing_event_row(
                    contract_id=(raw.get("Contract Id") or "").strip(),
                    customer_email=(raw.get("Customer Email") or "").strip(),
                    outcome="success",
                    billing_date=(raw.get("Billing Date") or "").strip() or None,
                    attempt_number=_parse_int(raw.get("No of Attempt", "")),
                    error_code=None,
                    error_message=None,
                    total_successful_orders=None,
                    last_successful_order_name=(raw.get("Order Name") or "").strip() or None,
                    last_successful_order_date=None,
                    order_amount=_parse_float(raw.get("Order Amount", "")) or None,
                    utm=utm,
                )
            )
    return rows


def load_appstle_failed_orders(path: str) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    with open(path, encoding="utf-8-sig", newline="") as f:
        for raw in csv.DictReader(f):
            rows.append(
                _billing_event_row(
                    contract_id=(raw.get("Contract Id") or "").strip(),
                    customer_email=(raw.get("Customer Email") or "").strip(),
                    outcome="failed",
                    billing_date=(raw.get("Billing Date") or "").strip() or None,
                    attempt_number=_parse_int(raw.get("No of Attempt", "")),
                    error_code=(raw.get("Error Code") or "").strip() or None,
                    error_message=(raw.get("Error Message") or "").strip() or None,
                    total_successful_orders=_parse_int(raw.get("Total Successful Orders", "")),
                    last_successful_order_name=(raw.get("Last Successful Order") or "").strip() or None,
                    last_successful_order_date=(raw.get("Last Successful Order Date") or "").strip() or None,
                    order_amount=None,
                    utm={},
                )
            )
    return rows


def load_appstle_skipped_dunning(path: str) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    with open(path, encoding="utf-8-sig", newline="") as f:
        for raw in csv.DictReader(f):
            rows.append(
                _billing_event_row(
                    contract_id=(raw.get("Contract Id") or "").strip(),
                    customer_email=(raw.get("Customer Email") or "").strip(),
                    outcome="skipped_dunning",
                    billing_date=(raw.get("Billing Date") or "").strip() or None,
                    attempt_number=None,
                    error_code=(raw.get("Error Code") or "").strip() or None,
                    error_message=(raw.get("Error Message") or "").strip() or None,
                    total_successful_orders=_parse_int(raw.get("Total Successful Orders", "")),
                    last_successful_order_name=(raw.get("Last Successful Order") or "").strip() or None,
                    last_successful_order_date=(raw.get("Last Successful Order Date") or "").strip() or None,
                    order_amount=None,
                    utm={},
                )
            )
    return rows


def load_appstle_billing_events() -> tuple[list[dict[str, Any]], dict[str, str | None]]:
    """Finds and parses whichever of the 3 ANALYTICS_*_past_orders_export
    CSVs are present in manual-exports/ (each is independently optional —
    Mikael may only have pulled some of them), returning the combined,
    normalized row list plus a {outcome: source_filename} map for
    provenance. Mirrors find_latest_export()'s "most recent by filename"
    convention for each of the 3 prefixes independently."""
    events: list[dict[str, Any]] = []
    sources: dict[str, str | None] = {"success": None, "failed": None, "skipped_dunning": None}

    success_path = find_latest_export("ANALYTICS_success_past_orders_export")
    if success_path:
        events.extend(load_appstle_success_orders(success_path))
        sources["success"] = os.path.basename(success_path)

    failed_path = find_latest_export("ANALYTICS_failed_past_orders_export")
    if failed_path:
        events.extend(load_appstle_failed_orders(failed_path))
        sources["failed"] = os.path.basename(failed_path)

    skipped_path = find_latest_export("ANALYTICS_skipped_dunning_past_orders_export")
    if skipped_path:
        events.extend(load_appstle_skipped_dunning(skipped_path))
        sources["skipped_dunning"] = os.path.basename(skipped_path)

    return events, sources
