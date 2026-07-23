# Badrock — Subscription & Revenue Analytics

A static analytics site for the Badrock DTC brand, focused on subscription
lifecycle metrics (MRR, churn by renewal cycle, cohort retention, LTV)
alongside general revenue/product/customer KPIs.

Data sources:
- **Shopify Admin GraphQL API** — orders, customers, line items.
- **Appstle Subscriptions Admin API** — subscription contracts and the
  billing-attempt ledger. This is the source of truth for subscription
  status/churn/MRR — **not** Shopify's native Subscriptions API, which
  Badrock does not use (recurring billing runs through Appstle).

## How it stays up to date

A GitHub Actions workflow (`.github/workflows/refresh-and-deploy.yml`) runs
every hour: pulls fresh data from both APIs, recomputes every metric, and
redeploys the static site to GitHub Pages. Each run is a full, stateless
refresh — no database or cache persists between runs (see the design note
at the top of `etl/run.py` for why that's the deliberate, correct choice
here rather than an incremental pull).

## Repo layout

```
etl/     Python ETL: pulls Shopify + Appstle, computes metrics, exports JSON
site/    Vite + React + TypeScript + Tailwind static site, reads that JSON
```

## Local setup

### 1. ETL

```bash
cd etl
pip install -r requirements.txt
cp ../.env.example ../.env   # fill in real credentials
python run.py
```

This writes `site/public/data/*.json`. `SHOPIFY_CLIENT_ID` /
`SHOPIFY_CLIENT_SECRET` are the same credentials the old `BR - Data
Analyzer` tool used. `APPSTLE_API_KEY` is new — generate one at **Appstle
admin → Settings → API Key Management** (key starts with `apst_`).

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
   - `APPSTLE_API_KEY`
   And repo variables (same page, "Variables" tab — not secret, just
   config):
   - `SHOPIFY_SHOP_DOMAIN` (`fegbrands.myshopify.com`)
   - `SHOPIFY_API_VERSION` (`2025-01`)
4. Run the workflow once manually (Actions tab → "Refresh data and
   deploy" → Run workflow) to get the first deployment; after that it runs
   hourly on its own.

## Metrics reference

All subscription metrics (`etl/metrics/subscriptions.py`) are derived from
Appstle's `subscription-contract-details` and
`subscription-billing-attempts/past-orders/report` endpoints:

- **MRR** — sum of every `ACTIVE` contract's charge, normalized to a
  monthly-equivalent rate by its billing interval (monthly/bimonthly/
  trimonthly all convert to a comparable number).
- **Churn by renewal cycle** — a contract's `SUCCESS` billing attempts are
  ordered chronologically to derive its cycle number (1st renewal, 2nd,
  ...). Churn at cycle N = contracts whose last successful cycle is N and
  are now `CANCELLED`, divided by contracts that reached cycle N at all.
- **Monthly churn** — calendar-month cancellations divided by subscribers
  active at the start of that month. Distinct from the above: this is
  churn on the calendar, not per renewal.
- **Cohort retention** — contracts grouped by acquisition month × plan,
  reporting what % of that cohort reached each cycle.
- **LTV** — Appstle's own `lifetimeValueUSD` per contract (computed by
  Appstle from actual billing history), averaged overall and by plan. This
  is a live snapshot, not a converged number — it will keep rising until
  every contract in a cohort has eventually cancelled.
