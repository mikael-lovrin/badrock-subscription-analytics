"""
Central configuration for the ETL pipeline.

All values are read from environment variables (populated from a local .env
file in development, or from GitHub Actions repo secrets in CI). Nothing here
should ever hold a literal credential.
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

# Root of the project (one level up from this file), used to resolve the
# JSON export destination consistently regardless of the working directory
# the script is invoked from.
PROJECT_ROOT = Path(__file__).resolve().parent.parent

# Where the exported JSON files land. The site's build step reads directly
# from this directory, so it must match site/public/data.
EXPORT_DIR = PROJECT_ROOT / "site" / "public" / "data"


@dataclass(frozen=True)
class ShopifyConfig:
    shop_domain: str
    client_id: str
    client_secret: str
    api_version: str

    @property
    def graphql_url(self) -> str:
        return f"https://{self.shop_domain}/admin/api/{self.api_version}/graphql.json"

    @property
    def oauth_token_url(self) -> str:
        return f"https://{self.shop_domain}/admin/oauth/access_token"


def load_shopify_config() -> ShopifyConfig:
    shop_domain = os.environ.get("SHOPIFY_SHOP_DOMAIN", "fegbrands.myshopify.com")
    client_id = os.environ["SHOPIFY_CLIENT_ID"]
    client_secret = os.environ["SHOPIFY_CLIENT_SECRET"]
    api_version = os.environ.get("SHOPIFY_API_VERSION", "2025-01")
    return ShopifyConfig(shop_domain, client_id, client_secret, api_version)
