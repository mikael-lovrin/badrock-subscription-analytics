"""
Runs every metrics module against the scratch database and writes the
result as JSON files under site/public/data/ — the only contract between
the ETL and the frontend. Each file also carries a generated_at timestamp
so the site can show "data as of ..." rather than implying true real-time.
"""
from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from metrics import customers as customers_metrics
from metrics import revenue as revenue_metrics
from metrics import subscriptions as subscription_metrics


def export_all(conn: sqlite3.Connection, export_dir: Path) -> None:
    export_dir.mkdir(parents=True, exist_ok=True)
    generated_at = datetime.now(timezone.utc).isoformat()

    payloads = {
        "subscriptions": subscription_metrics.compute_all(conn),
        "revenue": revenue_metrics.compute_all(conn),
        "customers": customers_metrics.compute_all(conn),
    }

    for name, payload in payloads.items():
        out = {"generated_at": generated_at, "data": payload}
        (export_dir / f"{name}.json").write_text(
            json.dumps(out, indent=2, default=str), encoding="utf-8"
        )

    print(f"Exported {len(payloads)} JSON files to {export_dir} at {generated_at}")
