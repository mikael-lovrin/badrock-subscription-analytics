"""
Transforms raw API payloads (Shopify GraphQL nodes, Appstle JSON objects)
into the flat row dicts db.insert_many() expects. Kept separate from the
API clients so the "shape of our schema" concern doesn't leak into the
"how do we talk to this API" concern.
"""
from __future__ import annotations

from typing import Any


def _shopify_gid_to_id(gid: str) -> str:
    """Shopify GraphQL IDs look like 'gid://shopify/Order/123' — we keep
    the full gid as our primary key (guaranteed unique, no parsing needed
    elsewhere), this helper exists only for readability at call sites that
    conceptually want "the id"."""
    return gid


def orders_and_line_items_from_shopify(
    order_nodes: list[dict[str, Any]],
) -> tuple[list[dict], list[dict]]:
    order_rows: list[dict] = []
    line_item_rows: list[dict] = []

    for node in order_nodes:
        customer = node.get("customer") or {}
        address = customer.get("defaultAddress") or {}

        order_rows.append(
            {
                "id": _shopify_gid_to_id(node["id"]),
                "order_name": node["name"],
                "created_at": node["createdAt"],
                "customer_id": customer.get("id"),
                "email": customer.get("email"),
                "total_price": float(
                    node["currentTotalPriceSet"]["shopMoney"]["amount"]
                ),
                "financial_status": node["displayFinancialStatus"],
                "city": address.get("city"),
                "province": address.get("provinceCode"),
                "country": address.get("countryCode"),
            }
        )

        for edge in node["lineItems"]["edges"]:
            li = edge["node"]
            line_item_rows.append(
                {
                    "id": li["id"],
                    "order_id": node["id"],
                    "title": li["title"],
                    "quantity": li["quantity"],
                    "price": float(li["originalUnitPriceSet"]["shopMoney"]["amount"]),
                }
            )

    return order_rows, line_item_rows


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


def subscription_contracts_from_appstle(contracts: list[dict[str, Any]]) -> list[dict]:
    rows = []
    for c in contracts:
        rows.append(
            {
                "contract_id": str(c["subscriptionContractId"]),
                "customer_id": str(c.get("customerId")) if c.get("customerId") else None,
                "customer_email": c.get("customerEmail"),
                "status": c.get("status"),
                "billing_interval": c.get("billingPolicyInterval"),
                "billing_interval_count": c.get("billingPolicyIntervalCount"),
                "created_at": c.get("createdAt"),
                "activated_on": c.get("activatedOn"),
                "cancelled_on": c.get("cancelledOn"),
                "next_billing_date": c.get("nextBillingDate"),
                "order_amount": c.get("orderAmount"),
                "currency": c.get("currencyCode"),
                "min_cycles": c.get("minCycles"),
                "max_cycles": c.get("maxCycles"),
                # totalSuccessfulOrders / lifetimeValue live on the billing
                # attempts report's nested subscriptionContractDetails, not
                # on this endpoint's payload — filled in later by
                # load.enrich_contracts_with_ltv().
                "total_successful_orders": None,
                "lifetime_value": None,
                "lifetime_value_usd": None,
            }
        )
    return rows


def enrich_contracts_with_ltv(
    contract_rows: list[dict], billing_attempts_raw: list[dict[str, Any]]
) -> list[dict]:
    """
    The past-orders report's `subscriptionContractDetails` block carries
    totalSuccessfulOrders / lifetimeValue per contract, computed by Appstle
    from the full billing history. We take the most recently seen value per
    contract (attempts are not guaranteed to arrive in order across the
    per-status pagination loop) and merge it onto the contract rows built
    from subscription-contract-details.
    """
    latest_by_contract: dict[str, dict[str, Any]] = {}
    for raw in billing_attempts_raw:
        details = raw.get("subscriptionContractDetails") or {}
        contract_id = details.get("contractId")
        if contract_id is None:
            continue
        latest_by_contract[str(contract_id)] = details

    for row in contract_rows:
        details = latest_by_contract.get(row["contract_id"])
        if details is None:
            continue
        row["total_successful_orders"] = details.get("totalSuccessfulOrders")
        row["lifetime_value"] = details.get("lifetimeValue")
        row["lifetime_value_usd"] = details.get("lifetimeValueUSD")

    return contract_rows


def billing_attempts_from_appstle(raw: list[dict[str, Any]]) -> list[dict]:
    rows = []
    for item in raw:
        attempt = item.get("subscriptionBillingAttempt") or {}
        if not attempt:
            continue
        rows.append(
            {
                "attempt_id": str(attempt["id"]),
                "contract_id": str(attempt["contractId"]),
                "order_id": str(attempt.get("orderId")) if attempt.get("orderId") else None,
                "order_name": attempt.get("orderName"),
                "status": attempt.get("status"),
                "billing_date": attempt.get("billingDate"),
                "attempt_time": attempt.get("attemptTime"),
                "order_amount": attempt.get("orderAmount"),
                "attempt_count": attempt.get("attemptCount"),
            }
        )
    return rows
