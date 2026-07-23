# Badrock — Subscription & Revenue Analytics

A static analytics site for the Badrock DTC brand, focused on subscription
lifecycle metrics (MRR, churn by renewal cycle, cohort retention, LTV)
alongside general revenue/product/customer KPIs — with a global filter for
product (multi-select) and date range.

## Data source

**Shopify Admin GraphQL API** is the only external data source — orders,
customers, line items. Badrock's Appstle Subscriptions plan doesn't
include External API access (confirmed 2026-07-23; upgrading wasn't worth
it for this), so subscription lifecycle is reconstructed entirely from
Shopify order history instead of a real billing ledger:

- Appstle tags every order it creates with `appstle_subscription_first_order`
  or `appstle_subscription_recurring_order` — that's the primary signal
  used to tell a subscriber's first order from a renewal.
- A subscriber's renewal **cycle number** = how many of those tagged orders
  they've placed, in date order, for a given (customer, product) pair.
  Cycle 1 = their **first renewal** (2nd order), not their initial
  purchase — see the convention agreed with Mikael on 2026-07-23.
- **Status (ACTIVE/CANCELLED) is inferred, not observed**: a subscriber
  counts as ACTIVE if a new order arrived within 1.5× their billing
  interval, otherwise CANCELLED as of their expected next billing date.
  There's no real cancellation event behind that — see the caveat banner
  on the site's Subscriptions page, and `buildContracts()` in
  `site/src/lib/metricsEngine.ts`.
- Internal test orders (known staff emails/domains, `teste`/`test` in the
  name, or suspiciously low totals like $0/$1/$5) are filtered out before
  anything else — see `etl/load.py`'s `is_test_order()`.

If Badrock's Appstle plan is ever upgraded to include API access, this
whole approximation can be replaced with real billing-ledger data — the
site's metric definitions (MRR, churn-by-cycle, cohort retention, LTV)
would stay the same, just fed from a different, more accurate source.

## How it stays up to date

A GitHub Actions workflow (`.github/workflows/refresh-and-deploy.yml`) runs
every hour: pulls fresh orders/customers from Shopify, cleans them, and
redeploys the static site to GitHub Pages. Each run is a full, stateless
refresh — nothing persists between runs (see the design note at the top of
`etl/run.py`).

## Architecture

```
etl/     Python — pulls Shopify orders/customers, filters test orders,
         canonicalizes product names, exports raw JSON (no SQL, no
         precomputed metrics — see etl/run.py)
site/    Vite + React + TypeScript + Tailwind static site. Every metric
         (MRR, churn, cohort retention, revenue trend, etc.) is computed
         client-side in site/src/lib/metricsEngine.ts, reactively, against
         whatever product-multi-select + date-range filter the user has
         picked (see site/src/lib/FilterContext.tsx) — that's what makes
         those two global filters possible without a backend.
```

Why compute metrics client-side instead of in Python: the site needs to
answer "MRR for these 2 of 5 products, for this date range" for any
combination the user might pick. Precomputing every combination
server-side doesn't scale combinatorially; shipping the ~350 orders' worth
of raw (cleaned) data and computing reactively in the browser does, and at
Badrock's current order volume the payload is trivially small.

## Local setup

### 1. ETL

```bash
cd etl
pip install -r requirements.txt
cp ../.env.example ../.env   # fill in real Shopify credentials
python run.py
```

This writes `site/public/data/{orders,customers,meta}.json`.
`SHOPIFY_CLIENT_ID` / `SHOPIFY_CLIENT_SECRET` are the same client-credentials
app the old `BR - Data Analyzer` tool used.

### 2. Site

```bash
cd site
npm install
npm run dev      # local dev server, reads whatever is in public/data/
npm run build    # production build to site/dist
```

## Deploying

1. Push this repo to GitHub.
2. Repo **Settings → Pages → Build and deployment → Source: GitHub
   Actions**.
3. Add repo secrets (**Settings → Secrets and variables → Actions**):
   - `SHOPIFY_CLIENT_ID`
   - `SHOPIFY_CLIENT_SECRET`
   And repo variables (same page, "Variables" tab — not secret, just
   config):
   - `SHOPIFY_SHOP_DOMAIN` (`fegbrands.myshopify.com`)
   - `SHOPIFY_API_VERSION` (`2025-01`)
4. Run the workflow once manually (Actions tab → "Refresh data and
   deploy" → Run workflow) to get the first deployment; after that it runs
   hourly on its own.

## Product naming

Shopify order line-item titles are frozen at the moment of purchase —
renaming a product in the catalog does **not** retroactively change past
orders' titles, only new orders pick up the new name. `etl/load.py`'s
`_PRODUCT_ALIASES` map bridges old and new titles to one canonical SKU
name per product (confirmed against the live product catalog on
2026-07-23: Bedroom Bundle, Bedroom Stripes, Beef Organ Complex → "Beef
Organs", Prime Organs Caps, Prime Organs Powder, Dewlyte). Extend that map
when more naming drift turns up — don't add code elsewhere for it.

## Metrics reference

All subscription metrics (`site/src/lib/metricsEngine.ts`) are derived
from `buildContracts()`, which groups Appstle-tagged order line items by
(customer, product):

- **MRR** — sum of every `ACTIVE` contract's most recent charge,
  normalized to a monthly-equivalent rate by its billing interval
  (monthly/bimonthly/trimonthly all convert to a comparable number). A
  snapshot metric — not affected by the date-range filter, only by the
  product filter.
- **Churn by renewal cycle** — cycle 1 = first renewal. Churn at cycle N =
  contracts whose last successful renewal is N and are now `CANCELLED`,
  divided by contracts that reached cycle N at all.
- **Monthly churn** — calendar-month cancellations divided by subscribers
  active at the start of that month. Distinct from churn-by-cycle: this is
  churn on the calendar, not per renewal.
- **Cohort retention** — contracts grouped by acquisition month × plan,
  reporting what % of that cohort reached each renewal cycle.
- **LTV** — sum of all charges to date per contract, averaged overall and
  by plan. A live snapshot, not a converged number — it will keep rising
  until every contract in a cohort has eventually cancelled.

The product filter (multi-select) and date-range filter apply everywhere:
product filtering restricts which contracts/orders are considered at all;
date-range filtering restricts which acquisition cohorts are included for
subscription metrics, and which orders count for revenue/order metrics
(MRR is the one exception — always a live snapshot).
