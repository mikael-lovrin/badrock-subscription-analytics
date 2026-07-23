"""
Appstle Subscriptions Admin API client.

This is the source of truth for subscription lifecycle at Badrock — the
store's recurring billing runs on the Appstle Subscriptions app, not native
Shopify Subscriptions, so `subscriptionContracts` on the Shopify GraphQL API
is always empty and must not be used for subscription data.

Reference: https://developers.appstle.com/subscription-admin-api/
"""
from __future__ import annotations

from collections.abc import Iterator
from typing import Any

import requests

from config import AppstleConfig

_REQUEST_TIMEOUT_SECONDS = 30
_PAGE_SIZE = 2000  # Appstle's documented maximum page size.

# Every billing-attempt status Appstle can report, per the API docs. The
# past-orders report endpoint's `status` query parameter is documented as
# required, so we fetch it once per status rather than assuming an
# unfiltered call returns everything. Statuses are mutually exclusive per
# attempt, so looping like this cannot produce duplicate rows.
_BILLING_ATTEMPT_STATUSES = [
    "SUCCESS",
    "FAILURE",
    "REQUESTING",
    "PROGRESS",
    "QUEUED",
    "SKIPPED",
    "SOCIAL_CONNECTION_NULL",
    "CONTRACT_CANCELLED",
    "CONTRACT_ENDED",
    "CONTRACT_PAUSED",
    "AUTO_CHARGE_DISABLED",
    "SHOPIFY_EXCEPTION",
    "SKIPPED_DUNNING_MGMT",
    "SKIPPED_INVENTORY_MGMT",
    "IMMEDIATE_TRIGGERED",
    "SECURITY_CHALLENGE",
    "CONTRACT_PAUSED_MAX_CYCLES",
    "REFUNDED",
    "SKIPPED_DEMO_SHOP",
    "SKIPPED_SHOP_INFO_NOT_FOUND",
    "SKIPPED_BILLING_DATE_STALE",
    "SKIPPED_DUNNING_NOT_CONFIGURED",
    "PENDING_CONSOLIDATION",
]


class AppstleClient:
    def __init__(self, cfg: AppstleConfig):
        self._cfg = cfg

    def _headers(self) -> dict[str, str]:
        return {"X-API-Key": self._cfg.api_key}

    def _get(self, path: str, params: dict[str, Any]) -> list[dict[str, Any]]:
        resp = requests.get(
            f"{self._cfg.base_url}{path}",
            params=params,
            headers=self._headers(),
            timeout=_REQUEST_TIMEOUT_SECONDS,
        )
        resp.raise_for_status()
        return resp.json()

    # ------------------------------------------------------------------
    # Subscription contracts — one row per subscriber, current snapshot.
    # ------------------------------------------------------------------

    def iter_contracts(self) -> Iterator[dict[str, Any]]:
        """
        Yields every subscription contract regardless of status (ACTIVE,
        PAUSED, CANCELLED). Full history is pulled every run — see
        etl/run.py for why the ETL is stateless — so no date filter is
        applied.
        """
        page = 0
        while True:
            batch = self._get(
                "/subscription-contract-details",
                {"page": page, "size": _PAGE_SIZE},
            )
            if not batch:
                break
            yield from batch
            if len(batch) < _PAGE_SIZE:
                break
            page += 1

    # ------------------------------------------------------------------
    # Billing attempts — the append-only ledger cohort/churn math is built
    # on. Each row is one renewal attempt (success, failure, skip, etc.)
    # for one contract.
    # ------------------------------------------------------------------

    def iter_billing_attempts(self) -> Iterator[dict[str, Any]]:
        for status in _BILLING_ATTEMPT_STATUSES:
            page = 0
            while True:
                batch = self._get(
                    "/subscription-billing-attempts/past-orders/report",
                    {"status": status, "page": page, "size": _PAGE_SIZE},
                )
                if not batch:
                    break
                yield from batch
                if len(batch) < _PAGE_SIZE:
                    break
                page += 1
