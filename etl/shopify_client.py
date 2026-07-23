"""
Shopify Admin GraphQL client.

Pulls orders, customers, and line items. Badrock's Appstle plan doesn't
include External API access (confirmed 2026-07-23 — 401 on every Appstle
Admin endpoint, and not worth upgrading for), so subscription lifecycle
truth is reconstructed entirely from Shopify order data instead: Appstle
tags every order it creates with `appstle_subscription_first_order` or
`appstle_subscription_recurring_order` (pulled here via the `tags` field),
which is what load.py uses to tell a subscription's first order from its
renewals — see load.derive_subscriptions_from_orders().

Auth: OAuth client-credentials grant (no redirect URI). The access token is
short-lived (~24h) and is re-fetched fresh at the start of every run rather
than cached to disk — the ETL is stateless by design (see etl/run.py), so
there is no persistent .env to write a cached token into inside CI.
"""
from __future__ import annotations

from collections.abc import Iterator
from typing import Any

import requests

from config import ShopifyConfig

_REQUEST_TIMEOUT_SECONDS = 30


class ShopifyClient:
    def __init__(self, cfg: ShopifyConfig):
        self._cfg = cfg
        self._access_token = self._fetch_access_token()

    def _fetch_access_token(self) -> str:
        resp = requests.post(
            self._cfg.oauth_token_url,
            json={
                "grant_type": "client_credentials",
                "client_id": self._cfg.client_id,
                "client_secret": self._cfg.client_secret,
            },
            timeout=_REQUEST_TIMEOUT_SECONDS,
        )
        resp.raise_for_status()
        return resp.json()["access_token"]

    def _headers(self) -> dict[str, str]:
        return {
            "X-Shopify-Access-Token": self._access_token,
            "Content-Type": "application/json",
        }

    def _run_query(self, query: str, variables: dict[str, Any]) -> dict[str, Any]:
        resp = requests.post(
            self._cfg.graphql_url,
            json={"query": query, "variables": variables},
            headers=self._headers(),
            timeout=_REQUEST_TIMEOUT_SECONDS,
        )
        resp.raise_for_status()
        payload = resp.json()
        if "errors" in payload:
            raise RuntimeError(f"Shopify GraphQL error: {payload['errors']}")
        return payload["data"]

    def _paginate(
        self, query: str, root_key: str, variables: dict[str, Any] | None = None
    ) -> Iterator[dict[str, Any]]:
        """Cursor-based pagination shared by every connection query below."""
        cursor = None
        while True:
            vars_ = {**(variables or {}), "cursor": cursor}
            data = self._run_query(query, vars_)
            connection = data[root_key]
            for edge in connection["edges"]:
                yield edge["node"]
            page_info = connection["pageInfo"]
            if not page_info["hasNextPage"]:
                break
            cursor = page_info["endCursor"]

    # ------------------------------------------------------------------
    # Orders
    # ------------------------------------------------------------------

    _ORDERS_QUERY = """
        query GetOrders($cursor: String) {
          orders(first: 250, after: $cursor, sortKey: CREATED_AT) {
            pageInfo { hasNextPage endCursor }
            edges {
              node {
                id
                name
                createdAt
                displayFinancialStatus
                tags
                currentTotalPriceSet { shopMoney { amount } }
                customer {
                  id
                  email
                  firstName
                  lastName
                  defaultAddress { city provinceCode countryCode }
                }
                lineItems(first: 50) {
                  edges {
                    node {
                      id
                      title
                      variantTitle
                      quantity
                      originalUnitPriceSet { shopMoney { amount } }
                    }
                  }
                }
              }
            }
          }
        }
    """

    def iter_orders(self) -> Iterator[dict[str, Any]]:
        """
        Yields every order in the store. Full history is pulled on every
        run (see etl/run.py for why the ETL is stateless) rather than
        filtered by a since-date, so no query-string date filter is applied
        here.
        """
        yield from self._paginate(self._ORDERS_QUERY, "orders")

    # ------------------------------------------------------------------
    # Customers
    # ------------------------------------------------------------------

    _CUSTOMERS_QUERY = """
        query GetCustomers($cursor: String) {
          customers(first: 250, after: $cursor) {
            pageInfo { hasNextPage endCursor }
            edges {
              node {
                id
                email
                firstName
                lastName
                createdAt
                numberOfOrders
                amountSpent { amount }
                defaultAddress { city provinceCode countryCode }
              }
            }
          }
        }
    """

    def iter_customers(self) -> Iterator[dict[str, Any]]:
        yield from self._paginate(self._CUSTOMERS_QUERY, "customers")
