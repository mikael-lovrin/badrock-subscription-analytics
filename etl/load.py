"""
Transforms raw Shopify GraphQL payloads into the flat, cleaned row shape
that gets exported straight to JSON for the site to consume (see
etl/run.py). No SQL, no intermediate database: at Badrock's current order
volume (~400 orders), plain Python lists are simpler and the site computes
every metric client-side anyway (see site/src/lib/metricsEngine.ts) so
there's nothing for a database to serve here.
"""
from __future__ import annotations

import re
from typing import Any

# ---------------------------------------------------------------------------
# Test-order filtering — ported from the old BR - Data Analyzer tool's
# clean_orders.py, which the team had already tuned to catch internal
# testing noise. Kept as a single source of truth here so it's applied
# automatically on every ETL run instead of as a manual one-off script.
# ---------------------------------------------------------------------------

_TEST_AMOUNTS = {0.0, 1.0, 5.0}

_KNOWN_TEST_EMAILS = {
    "nathan@crearite.com.br",
    "mateusfj8144@gmail.com",
    "guilherme@grupofeg.com",
    "james007xbox@hotmail.com",
    "brittney.thayna@grupofeg.com",
    "leandro.cancherini@grupofeg.com",
}

_INTERNAL_DOMAINS = {"grupofeg.com", "crearite.com.br"}


def is_test_order(total_price: float, email: str | None, first_name: str | None, last_name: str | None) -> str | None:
    """Returns a reason string if the order looks like internal testing
    noise rather than a real customer order, else None."""
    if total_price in _TEST_AMOUNTS:
        return f"test_amount_{total_price}"

    email_lower = (email or "").strip().lower()
    if email_lower in _KNOWN_TEST_EMAILS:
        return "known_test_email"

    domain = email_lower.split("@")[-1] if "@" in email_lower else ""
    if domain in _INTERNAL_DOMAINS:
        return "internal_domain"

    first = (first_name or "").strip().lower()
    last = (last_name or "").strip().lower()
    if "teste" in first or "teste" in last or "test" in first or "test" in last:
        return "name_contains_test"

    return None


# ---------------------------------------------------------------------------
# Product naming — Shopify order line-item titles are frozen at the moment
# of purchase, so renaming a product in the catalog does NOT retroactively
# change historical orders' titles — only new orders placed after a rename
# pick up the new name. That means old and new titles for the same product
# coexist forever in order history, and both need to map to one canonical
# name here for the site's SKU filter to treat them as one product.
#
# Canonical names below match the live Shopify product catalog as of
# 2026-07-23 (confirmed via a direct product-catalog query, since catalog
# renames don't show up in past orders): "Bedroom Bundle", "Bedroom
# Stripes", "Dewlyte", "Beef Organ Complex" (aliased to Mikael's shorthand
# "Beef Organs"), "Prime Organs Caps", "Prime Organs Powder". Treat this as
# a living map: add/adjust entries here (not in Shopify) whenever more
# naming drift turns up.
#
# Judgment calls flagged for Mikael to double-check:
# - "BadRock - Prime Organs" (the old bare name, pre-Caps/Powder split) is
#   mapped to "Prime Organs Caps" as the presumed original/default variant
#   — Powder ("Po") reads as the later collagen-added addition.
# - "BadRock - Beef Prime Organs" doesn't match anything in the current
#   live catalog and isn't aliased — left as its own literal entry rather
#   than guessed into a bucket.
# ---------------------------------------------------------------------------

_PRODUCT_ALIASES: dict[str, str] = {
    # Bundle format — was "Unlock" before the brand's product naming
    # settled; "Unlock - New" / "Unlock - SMS" already collapse to "Unlock"
    # before this map even runs, since extract_product_name() ignores
    # anything after the [TAG].
    "BadRock Bundle": "Bedroom Bundle",
    "Unlock": "Bedroom Bundle",
    # Strips format — the bare "BadRock" title (no suffix) is what's now
    # branded as Bedroom Stripes.
    "BadRock": "Bedroom Stripes",
    # Beef Organ Complex naming drift across test phases + shorthand.
    "BadRock - BOC": "Beef Organs",
    "BadRock - Beef Organ Complex": "Beef Organs",
    "Beef Organ Complex": "Beef Organs",
    # Prime Organs later split into Caps (original) / Powder (+ collagen,
    # "Po") variants in the live catalog.
    "BadRock - Prime Organs": "Prime Organs Caps",
    "BadRock - Prime Organs Po": "Prime Organs Powder",
}


def _shopify_gid_to_id(gid: str) -> str:
    """Shopify GraphQL IDs look like 'gid://shopify/Order/123' — we keep
    the full gid as our primary key (guaranteed unique, no parsing needed
    elsewhere), this helper exists only for readability at call sites that
    conceptually want "the id"."""
    return gid


def extract_product_name(title: str) -> str | None:
    """
    Badrock's line-item title convention is "{Product} - [TAG] Variant",
    e.g. "BadRock - [R] Strips [F]" or "Unlock - [U1] Upsell" (see
    00-Admin/CLAUDE.md's product naming table). This strips the tag/variant
    suffix to get the base product name the site's SKU filter groups by,
    then applies _PRODUCT_ALIASES to collapse known naming drift.

    Returns None for titles with no [TAG] at all (bonuses/ebooks bundled
    into an order, e.g. "The 5 Cortisol Killers") — those aren't
    standalone SKUs, so callers should exclude them from the product
    filter while still counting them toward order revenue.
    """
    for separator in (" - [", " ["):
        idx = title.find(separator)
        if idx != -1:
            name = title[:idx].strip()
            return _PRODUCT_ALIASES.get(name, name)
    return None


def _is_subscription_title(title: str) -> bool:
    """[R]/[OT] live on the PRODUCT title, e.g. "Unlock - [R]" — this is
    reliable at the product level."""
    return "[r]" in title.lower()


def _is_upsell_variant(title: str, variant_title: str | None) -> bool:
    """
    [U1] (post-purchase upsell) lives on the VARIANT, not the product —
    confirmed against real order data 2026-07-24: a line item can have
    title "Unlock - [R]" (the recurring product) while its variantTitle is
    "1 Bundle [U1]" or even a completely different upsell offer like "1
    Sleep Rest [U1]", bundled as a variant under the subscription product
    rather than sold as its own product. Checking only `title` for "[u1]"
    (the old behavior) never caught these — they'd otherwise get counted
    as if they were a second, same-day subscription renewal.
    """
    if variant_title and "[u1]" in variant_title.lower():
        return True
    return "[u1]" in title.lower()


def _interval_months_from_variant(variant_title: str | None) -> int | None:
    """
    Front-end plan variants are named "{N} Bedroom Bundle(s) [F]" / "{N}
    Pack - [F]" etc., where N is the bottle count = the billing interval
    in months (1/2/3 = monthly/bimonthly/trimonthly) — reliable regardless
    of price, so a promo-priced variant (e.g. "1 Bedroom Bundle [F]" at
    $55 instead of $49, or "3 Bedroom Bundles [F] - 10%" at $105.30
    instead of $117) still resolves to the right plan. Returns None for
    upsell variants ([U1]) or anything that doesn't match this pattern —
    callers fall back to price-based plan lookup in that case.
    """
    if not variant_title or "[f]" not in variant_title.lower():
        return None
    match = re.match(r"\s*(\d+)", variant_title)
    return int(match.group(1)) if match else None


# ---------------------------------------------------------------------------
# Orders + line items
# ---------------------------------------------------------------------------


def orders_and_line_items_from_shopify(
    order_nodes: list[dict[str, Any]],
) -> tuple[list[dict], list[dict], int]:
    """
    Returns (order_rows, line_item_rows, test_orders_removed_count).

    Each order row carries `is_appstle_first_order` / `is_appstle_recurring_order`,
    parsed from the `appstle_subscription_first_order` / `appstle_subscription_recurring_order`
    tags Appstle stamps on every order it creates — this is the ground
    truth the site's subscription-cycle engine uses to tell a subscriber's
    first order from a renewal (see site/src/lib/metricsEngine.ts), far
    more reliable than guessing from price/title alone.
    """
    order_rows: list[dict] = []
    line_item_rows: list[dict] = []
    removed = 0

    for node in order_nodes:
        customer = node.get("customer") or {}
        address = customer.get("defaultAddress") or {}
        total_price = float(node["currentTotalPriceSet"]["shopMoney"]["amount"])

        reason = is_test_order(
            total_price, customer.get("email"), customer.get("firstName"), customer.get("lastName")
        )
        if reason:
            removed += 1
            continue

        tags = {t.lower() for t in node.get("tags", [])}

        order_rows.append(
            {
                "id": _shopify_gid_to_id(node["id"]),
                "order_name": node["name"],
                "created_at": node["createdAt"],
                "customer_id": customer.get("id"),
                "email": customer.get("email"),
                "total_price": total_price,
                "financial_status": node["displayFinancialStatus"],
                "city": address.get("city"),
                "province": address.get("provinceCode"),
                "country": address.get("countryCode"),
                "is_appstle_first_order": "appstle_subscription_first_order" in tags,
                "is_appstle_recurring_order": "appstle_subscription_recurring_order" in tags,
            }
        )

        for edge in node["lineItems"]["edges"]:
            li = edge["node"]
            title = li["title"]
            variant_title = li.get("variantTitle")
            line_item_rows.append(
                {
                    "id": li["id"],
                    "order_id": node["id"],
                    "title": title,
                    "variant_title": variant_title,
                    "product": extract_product_name(title),
                    "quantity": li["quantity"],
                    "price": float(li["originalUnitPriceSet"]["shopMoney"]["amount"]),
                    "is_subscription": _is_subscription_title(title),
                    "is_upsell": _is_upsell_variant(title, variant_title),
                    "interval_months": _interval_months_from_variant(variant_title),
                }
            )

    return order_rows, line_item_rows, removed


# ---------------------------------------------------------------------------
# Customers
# ---------------------------------------------------------------------------


def customers_from_shopify(customer_nodes: list[dict[str, Any]]) -> list[dict]:
    rows = []
    for node in customer_nodes:
        address = node.get("defaultAddress") or {}
        amount_spent = node.get("amountSpent") or {}
        rows.append(
            {
                "id": node["id"],
                "email": node.get("email"),
                "first_name": node.get("firstName"),
                "last_name": node.get("lastName"),
                "created_at": node["createdAt"],
                "orders_count": node.get("numberOfOrders"),
                "total_spent": float(amount_spent.get("amount", 0) or 0),
                "city": address.get("city"),
                "province": address.get("provinceCode"),
                "country": address.get("countryCode"),
            }
        )
    return rows
