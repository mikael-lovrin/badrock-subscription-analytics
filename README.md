# Badrock — Subscription & Revenue Analytics

A static analytics site for the Badrock DTC brand, focused on subscription
lifecycle metrics (MRR, churn by renewal cycle, cohort retention, LTV)
alongside general revenue/product/customer KPIs — with a global filter for
product (multi-select) and date range.

## Data source

Two sources feed the site:

1. **Shopify Admin GraphQL API** (`etl/shopify_client.py`) — orders,
   customers, line items. Pulled automatically every hour, no manual step.
2. **A manually-exported Appstle subscription CSV** (`etl/appstle_csv.py`,
   dropped by hand into `etl/manual-exports/` — see below) — real
   subscription-ledger status, used to override the Shopify-based
   inference wherever a row can be matched. Manual because Badrock's
   Appstle plan doesn't include API access (confirmed 2026-07-23;
   upgrading wasn't worth it for this).

### ⚠️ Shopify order history is capped at 60 days

Confirmed 2026-07-31: the custom app's Admin API access, without the
**`read_all_orders`** scope, only returns orders from the **last 60
days** — a rolling window, so a little more history rolls off every day
the ETL runs. This was silently truncating cohort history and making
plenty of real renewals look like "no prior order exists for this
customer" (see the chat investigation around this date — order #1056,
for example, was invisible to every pull even though it's a completely
normal fulfilled order, just 63+ days old).

**Fix**: Shopify Admin → Settings → Apps and sales channels → **Develop
apps** → this app → Configuration → Admin API scopes → enable
`read_all_orders`. This is self-serve for a custom app installed on your
own store (no Shopify review needed, unlike a public/listed app). Do this
and re-run the ETL before trusting any cohort further back than ~2
months, or before assuming a "single order, no renewal history" contract
is a genuine data gap rather than just this cap.

**Fixed 2026-08-04** — `read_all_orders` is enabled; a fresh ETL run the
same day pulled order history back to 2026-05-21 (previously capped at a
rolling ~60 days), confirming the cap itself is no longer the limiting
factor. See the note right below, though: this did **not** resolve the
Bedroom Stripes gap, which turned out to be a separate, unrelated issue.

### Subscription lifecycle reconstruction (Shopify-only fallback)

**Update 2026-08-04:** the override described as a "should" below is now
implemented, not just aspirational. `buildContracts()` in
`site/src/lib/metricsEngine.ts` takes `RawAppstleSubscription[]` as a
parameter and, for every contract, tries to find a matching Appstle ledger
row (joined on lowercased customer email + product — the same join key
`computeSkippedDunningExposure`/the Appstle section already used, chosen
for the same reason: there's no shared contract id between Shopify and
Appstle at all, so this is a best-effort match, not a guaranteed-exact
one; see `findMatchingAppstleSub()`'s doc comment). When a match exists,
that row's real `status`/`cancellation_date` **replace** the
inferred ACTIVE/CANCELLED and `cancelledOn` outright — the heuristic below
only stands for contracts with no match. This fixed a real, confirmed
discrepancy: Bedroom Stripes (launched without stock, essentially 100%
cancelled per the real Appstle ledger — see "Real cancellation timing +
dunning funnel" below) was showing ~0% churn on the main Subscriptions
page's churn-by-cycle card, because the Shopify-silence heuristic hadn't
caught up yet for contracts still inside their grace window. Every caller
of `buildContracts()` (`Subscriptions.tsx`, `Overview.tsx`) now passes
`data.appstleSubscriptions` alongside the usual orders/line-items/product
args.

**Known edge case in the join:** a Shopify contract whose order has no
`email` can never match (the heuristic below is its only source of
truth). Where a customer has more than one Appstle row for the same
email+product (e.g. cancelled once and resubscribed later), the nearest
match by signup date (`created_at`) is used — there's no better
disambiguator without a shared id. And where the Shopify order history
itself has rolled off the 60-day-ish pull window entirely for a product
(see above), there's no Shopify contract to override in the first
place — the fix only helps once a Shopify-inferred contract exists to
attach the real status to.

**Fixed 2026-08-04: synthetic contracts for products with zero Shopify
history left.** The override above only ever adjusts an *existing*
Shopify-derived contract's status — it can't create one from thin air.
Bedroom Stripes exposed the gap concretely: its 8 real Appstle
subscriptions were created 2026-06-07/08 and cancelled 2026-07-06, and
`buildContracts()` found zero order-derived contracts for that product at
all, so every main-dashboard card built on top of it (churn-by-cycle, MRR,
active-subscriber counts) showed Bedroom Stripes as completely empty, even
though the Appstle section of the Subscriptions page (which reads
`appstleSubscriptions` directly, not through `buildContracts()`) showed
the real ~100% churn correctly the whole time.

**This was first assumed to be the 60-day Shopify pull cap (above) —
that assumption was wrong.** After `read_all_orders` was enabled and a
fresh ETL pull confirmed order history back to 2026-05-21 (well before
Stripes' June signup dates), **Bedroom Stripes still had zero Shopify
line items** across all 392 orders in that window. The actual cause is
unconfirmed — the leading theory is that these 8 subscriptions, created
while the product had launched without physical stock, never generated a
real completed Shopify order in the first place (as opposed to an order
that simply aged out of a pull window). Regardless of the exact cause,
the fix below doesn't depend on knowing it: `buildContracts()` now runs a
second pass after building Shopify-derived contracts — for every Appstle
row whose (email, product) pair wasn't already covered by a
Shopify-derived contract, it synthesizes a `Contract` directly from that
row (`synthesizeContractFromAppstleSub()` in `metricsEngine.ts`,
`contractId` prefixed `appstle::` so it can never collide with a
Shopify-derived id). This makes the main cards and the Appstle section
agree on churn for a product like Bedroom Stripes instead of one of them
silently showing zero, whether the underlying gap is a pull-window cap,
a missing order, or something else entirely.

Wherever no matching Appstle CSV row exists, subscription lifecycle is
reconstructed from Shopify order history instead of a real billing
ledger:

- Appstle tags every order it creates with `appstle_subscription_first_order`
  or `appstle_subscription_recurring_order` — the authoritative signal
  for "this order starts a brand-new subscription" vs. "this continues
  the customer's currently-open one" (see `buildContracts()`'s
  customer-level grouping in `site/src/lib/metricsEngine.ts` — contracts
  are grouped by customer, not by (customer, product), specifically so a
  product rename or format swap mid-subscription can't fracture cycle
  continuity the way it did before 2026-07-31).
- A subscriber's renewal **cycle number** = how many of those tagged orders
  they've placed, in date order. Cycle 1 = their **first renewal** (2nd
  order), not their initial purchase — see the convention agreed with
  Mikael on 2026-07-23.
- **Status (ACTIVE/CANCELLED) is inferred, not observed**: a subscriber
  counts as ACTIVE if a new order arrived within 1.1× their billing
  interval, otherwise CANCELLED as of their expected next billing date.
  Confirmed 2026-07-31 against a real Appstle export that this
  undercounts real cancellations substantially — plenty of subscribers
  cancel proactively, days before this heuristic would ever catch it.
  Prefer the Appstle CSV path (above) wherever possible; this is a
  fallback, not the primary source, despite being the only one that
  works without any manual step.
- Internal test orders (known staff emails/domains, `teste`/`test` in the
  name, suspiciously low totals like $0/$1/$5, or — since 2026-08-12 — the
  order carrying a `TESTE` tag, now added directly by the product team on
  test purchases and checked first, ahead of the older heuristics) are
  filtered out before anything else — see `etl/load.py`'s `is_test_order()`,
  reused as-is by `etl/appstle_csv.py` for the CSV path (the CSV export has
  no tags field, so that caller only ever gets the older heuristics).

If Badrock's Appstle plan is ever upgraded to include full API access,
this whole Shopify-inference fallback can be retired in favor of always
pulling the real ledger — the site's metric definitions (MRR,
churn-by-cycle, cohort retention, LTV) would stay the same, just fed from
a more accurate source for every contract instead of only the ones that
happen to match a manual CSV export.

### Appstle CSVs (manual — 4 exports, all optional/independent)

Appstle's dashboard offers 4 separate exports; the site can use any subset
that's actually been pulled (each is loaded independently, missing ones
just leave that section of the site empty rather than breaking anything):

1. **Subscriptions** (Subscriptions → Export) — `SUBSCRIPTION_export_*.csv`.
   The main ledger: one row per contract, current status, and — since the
   2026-08-04 export — real **Cancellation date** and **Cancellation
   reason/note** fields (see `etl/appstle_csv.py`'s
   `load_appstle_subscriptions()`).
2. **Successful past orders** (Analytics → Success) —
   `ANALYTICS_success_past_orders_export_*.csv`. One row per successful
   charge, including full UTM/campaign attribution — useful for
   creative-to-churn analysis.
3. **Failed past orders** (Analytics → Failed) —
   `ANALYTICS_failed_past_orders_export_*.csv`. One row per failed
   charge attempt (error code/message, attempt number, how many
   successful charges preceded it).
4. **Skipped dunning past orders** (Analytics → Skipped Dunning) —
   `ANALYTICS_skipped_dunning_past_orders_export_*.csv`. Contracts whose
   failed charge never entered Appstle's dunning-retry flow at all.

Steps:

1. Download whichever of the 4 exports you want to refresh from the
   Appstle dashboard.
2. Drop them into `etl/manual-exports/` (any filename Appstle gives them
   is fine — `find_latest_export(prefix)` in `etl/appstle_csv.py` picks
   the most recent file *per prefix* by filename automatically, so old and
   new exports of the same type can coexist there; it just always uses
   the newest). **Never commit these files** — they carry customer PII
   (phone, address, payment brand/last 4/expiry on the subscription
   export) that the site's JSON exports deliberately never include; the
   whole folder is gitignored (`etl/manual-exports/*.csv`) as a backstop,
   but don't rely on that alone.
3. Run the ETL locally (`python etl/run.py`, from the `etl/` directory).
   This parses whichever fresh CSVs are present **and** overwrites
   `etl/appstle_snapshot.json` (subscriptions) and
   `etl/appstle_billing_events_snapshot.json` (success/failed/skipped
   dunning, combined) — small, PII-trimmed cross-checks safe to commit
   (email + status/dates/UTMs, no phone/address/payment).
4. **Commit and push both snapshot files.** This step matters: the raw
   CSVs never leave your machine (gitignored, invisible to CI), so the
   hourly GitHub Actions run only ever sees whatever snapshots were last
   committed here — skip this and the deployed site keeps using stale (or
   absent) Appstle data indefinitely, even though Shopify data keeps
   refreshing hourly as normal.
5. Repeat periodically to keep the cross-checks fresh — there's no way to
   automate the export itself without Appstle API access. The
   success/failed/skipped-dunning exports in particular look like a
   rolling ~5-6 week window (not full history, confirmed 2026-08-04), so
   they're worth re-pulling more often than the subscription ledger if
   you want the dunning-funnel numbers to stay representative.

## How it stays up to date

A GitHub Actions workflow (`.github/workflows/deploy.yml`) runs
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
Organs", Prime Organs Caps, Prime Organs Powder). Extend that map
when more naming drift turns up — don't add code elsewhere for it.

The site's product filter (header, global — see "Architecture" above)
groups these into 4 user-facing categories: Bedroom Bundle, Bedroom
Stripes, Beef Organs, and "Prime Organs" (Caps + Powder combined for
filtering purposes only — the underlying data keeps them as two separate
canonical products). See `site/src/lib/FilterContext.tsx`'s
`PRODUCT_CATEGORIES` — the one place this grouping is defined; every
picker in the site builds off it rather than listing raw SKU strings.

### Dewlyte is excluded entirely, at the ETL level

Dewlyte is a **different FEG-group brand**, not a Badrock product (see
`Projects/Badrock/CLAUDE.md`'s product table) — it just happens to ride
the same shared Shopify store / Appstle setup Badrock uses, which is why
it used to show up in this tool's data with nothing filtering it out.
Since 2026-08-04, `etl/load.py`'s `_EXCLUDED_PRODUCTS` (currently just
`{"Dewlyte"}`) is filtered out at the ETL level, before any JSON is
written — orders, line items, customers (dropped if their only order(s)
in the current data are Dewlyte), Appstle subscriptions, and Appstle
billing events (joined to a Dewlyte subscription via `contract_id`). This
is not a UI toggle; Dewlyte never reaches `site/public/data/*.json` at
all. Extend `_EXCLUDED_PRODUCTS` the same way if another non-Badrock
brand ever shows up in a future pull.

## Metrics reference

All subscription metrics (`site/src/lib/metricsEngine.ts`) are derived
from `buildContracts()`, which groups Appstle-tagged order line items by
(customer, product):

- **MRR** — sum of every `ACTIVE` contract's most recent charge,
  normalized to a monthly-equivalent rate by its billing interval
  (monthly/bimonthly/trimonthly all convert to a comparable number). A
  snapshot metric — not affected by the date-range filter, only by the
  product filter. The Subscriptions page shows this **two ways side by
  side**: "including skipped dunning" (the plain calc above — every
  non-`CANCELLED` contract counts as paying) and "excluding skipped
  dunning" (see below) — shown together on purpose rather than picking
  one, since the join behind the "excluding" figure isn't guaranteed
  exact.
- **Skipped dunning exposure** (added 2026-08-04) — "skipped dunning" is
  Appstle's own term for: every retry attempt on a failed charge failed,
  and the contract's configured final action was "skip" rather than
  "cancel". The subscription stays `ACTIVE` in Appstle's ledger, but that
  billing cycle was never actually paid — a third state, distinct from a
  normally-paying `ACTIVE` contract and from `CANCELLED`. Left
  unaddressed, these accounts were silently inflating both the
  active-subscriber count and MRR. `computeSkippedDunningExposure()` in
  `metricsEngine.ts` flags a contract as "currently skipped" when its most
  recent known billing attempt (from the success/failed/skipped-dunning
  exports) is a skip, joins it to a Shopify-inferred contract by customer
  email, and feeds that into `computeMrr()`'s `excludeCustomerEmails` to
  produce the "excluding skipped dunning" MRR figure. See the
  "Skipped dunning exposure" card on the Subscriptions page for the live
  count and the two MRR figures side by side. **Limitation, surfaced in
  the UI, not just here:** the underlying exports are a rolling ~5-6 week
  window (see above), so a contract that skipped dunning further back
  than that with no billing activity since is invisible to this — treat
  the count as a lower bound, not a complete one. This is purely
  observational exposure, not a status change: no contract's real
  Appstle status is altered or auto-cancelled by this.
- **Revenue vs. MRR under skipped dunning (clarified 2026-08-04, no code
  change needed):** "Total revenue" (`computeRevenueSummary`, Overview
  page) is a straight sum of real Shopify order totals — a skipped-dunning
  cycle never creates an order, so it is already excluded automatically,
  with no special-casing required. MRR is the opposite by design: it's
  the committed recurring rate, not cash collected, so it intentionally
  keeps counting a skipped-dunning contract (the "including skipped
  dunning" figure above) unless you deliberately look at the "excluding"
  side-by-side figure. Don't conflate the two — revenue answers "what did
  we actually collect," MRR answers "what are we on the hook to deliver
  against." Both KPI cards on the Overview page now carry a hint
  explaining this distinction inline.
- **Churn by renewal cycle** — cycle 0 = the pre-first-renewal period every
  contract is born into; cycle 1 = first renewal, and so on. Churn at cycle
  N = contracts eligible for cycle N that didn't actually renew that many
  times, divided by contracts eligible for cycle N at all.

  **`cyclesDue` vs. `renewalsReached` (fixed 2026-08-05):** eligibility for
  cycle N — "has this contract's cycle-N renewal date come up at all" — used
  to be decided by `renewalsReached >= N`, i.e. *successful* renewals only.
  That conflated two very different cases under the same "renewalsReached:
  0" bucket: (1) a subscriber genuinely too new to have hit their first
  renewal date yet (correctly "aguardando"), and (2) a subscriber whose
  renewal charge WAS attempted on schedule, failed or got skipped
  (Appstle's "skipped dunning" — nominally still `ACTIVE`, never actually
  paid), and who eventually cancelled without a single successful
  renewal — a resolved, real churn event that the old logic silently
  dropped out of both `computeChurnByCycle` and `computeCohortRetention`'s
  denominators entirely, instead of counting it as churn at the cycle it
  happened on.

  `Contract.cyclesDue` (see its doc comment in `metricsEngine.ts`) fixes
  this: it's how many full `intervalMonths` periods have elapsed between
  `createdAt` and the reference date (`cancelledOn` if `CANCELLED`,
  otherwise now) — i.e. how many renewal dates *should* have come up,
  independent of whether the charge on each one succeeded. Eligibility for
  cycle N is now `cyclesDue >= N` (OR'd with `renewalsReached >= N` as a
  same-day-renewal edge-case guard — see `maturityAtCycle` in
  `metricsEngine.ts`); `renewalsReached` still decides the *numerator* —
  whether the outcome was real retention.

  **Real example that exposed the bug:** Nyle Wells
  (`nyle713@hotmail.com`, contract `appstle::21697429660`, Bedroom Bundle
  monthly) signed up 2026-05-28. Their 2026-06-28 renewal charge failed and
  was skipped by Appstle's dunning management (stayed `ACTIVE`, never
  paid); the 2026-07-28 retry failed again and Appstle marked the contract
  `CANCELLED`. `renewalsReached` stayed 0 the entire time (never a
  *successful* renewal), so the old logic treated them as "never reached a
  renewal" — the same bucket as a brand-new signup — and excluded them from
  both churn-by-cycle and cohort-retention denominators entirely.
  `cyclesDue` correctly reads 2 as of the cancellation date (two full
  monthly renewal windows genuinely came and went), so they're now counted
  as churn at both cycle 1 and cycle 2 — the correct read, since two
  renewal charges were attempted on schedule and both failed.

  Recomputed 2026-08-05: **66.7% of all-time cancelled contracts cancelled
  at "Renewal 0"** (before their first renewal date ever arrived,
  `cyclesDue === 0`) — replacing the 91% figure quoted before this fix,
  which used the old `renewalsReached === 0` definition and therefore
  counted cases like Nyle Wells (a resolved renewal-1/2 churn) as if they'd
  never had a renewal attempted at all.
- **Monthly churn** — calendar-month cancellations divided by subscribers
  active at the start of that month. Distinct from churn-by-cycle: this is
  churn on the calendar, not per renewal.
- **Cohort retention** — contracts grouped by acquisition month × plan (one
  triangle per plan on the site, cadences aren't comparable pooled),
  reporting what % of that cohort's *eligible* population (see `cyclesDue`
  above) actually reached each renewal cycle. "Renewal 0" = survived to see
  their first renewal date at all (whether or not that first charge
  succeeded) vs. cancelled before it ever arrived; "Renewal 1" onward =
  that cycle's renewal date has come and gone, resolved or not, and asks
  how many of those actually renewed that many times. Contracts still
  `ACTIVE` with too little elapsed time to have hit that cycle's renewal
  date (`cyclesDue < N`) are excluded from the denominator (rendered
  "aguardando" on the heatmap) rather than counted as churn — otherwise a
  cohort acquired last week reads as mostly-churned just because most of it
  hasn't had a chance to renew yet. May 2026 monthly cohort, cycle 1,
  unaffected by this fix (80%, 4/5 matured — Nyle Wells was already being
  counted there before, since other cohort members had genuinely reached
  cycle 1); cycle 2 dropped from 66.67% (2/3 matured) to 40% (2/5 matured)
  once eligibility correctly included Nyle Wells as matured-but-not-reached
  rather than silently excluded.
- **LTV** — sum of all charges to date per contract, averaged overall and
  by plan. A live snapshot, not a converged number — it will keep rising
  until every contract in a cohort has eventually cancelled.
- **Refunds (added 2026-08-12)** — confirmed with Mikael that "the refunded
  tag on the payment" is the order's own Shopify `displayFinancialStatus`
  (REFUNDED / PARTIALLY_REFUNDED — `REFUNDED_STATUSES` in
  `metricsEngine.ts`), the same payment-status signal `Contract.lastOrderRefunded`
  and the Plan comparison table's `— refunded` column already used — not a
  separate order tag. Four new views, all keying off that same signal:
  - `computeRefundSummary` — global count + rate over total orders
    (Overview page KPIs), respecting the header's product + date filters.
  - `computeRefundsByProduct` — same signal, segmented by product
    (Subscriptions page, "Refunds by product" card), mirroring
    `computeStockoutChurnByProduct`'s per-product cancellation breakdown.
  - `PlanMixRow.refundedOrders` / `refundRatePct` — segmented by plan
    (Subscriptions page, "Plan comparison" table), across ALL of that
    plan's orders — broader than the existing `cancelledRefunded` column,
    which only looks at a cancelled subscriber's very last order.
  - `CohortRetentionRow.refundedOrdersCount` / `refundRatePct` — segmented
    by acquisition month × plan (Subscriptions page, "Cohort retention"
    heatmap's new "Refunds" column), same grouping as the retention
    triangle itself.

The product filter (multi-select) and date-range filter apply everywhere:
product filtering restricts which contracts/orders are considered at all;
date-range filtering restricts which acquisition cohorts are included for
subscription metrics, and which orders count for revenue/order metrics
(MRR is the one exception — always a live snapshot).

**Note on the Appstle-derived views** (early-churn cohort, cancellation
timing, dunning funnel — see below): confirmed 2026-08-04 that these were
silently ignoring the header's product filter entirely (only the
Shopify-inference views under `buildContracts()` respected it). Fixed via
`filterAppstleSubsByProduct()` / `filterBillingEventsByProduct()` in
`metricsEngine.ts` — every Appstle-derived card on the Subscriptions page
now reacts to the same product picker as everything else, **except** the
"Churn: aggregate vs. Bundle-only vs. excluding stockout" comparison card,
which deliberately always uses the full unfiltered ledger since its whole
point is comparing scopes side by side.

### Real cancellation timing + dunning funnel (2026-08-04)

Added after Mikael pulled 4 richer Appstle exports (subscription ledger
with real cancellation date/reason, plus success/failed/skipped-dunning
past-orders). See `computeCancellationTiming`, `computeChurnComparison`,
`computeStockoutChurnByProduct`, and `computeDunningFunnel` in
`metricsEngine.ts`.

**What the EDA found** (240 real subscription rows in the 2026-08-04
export after test-order filtering — 250 raw, 10 removed; 43 cancelled,
of which 47 in the pre-filter raw count had usable cancellation dates —
the timing-pattern numbers below are drawn from that raw 47-row EDA pass,
the churn-rate numbers from the real 240/43):

- **Cancellations do NOT cluster right after product delivery.** Of
  cancelled contracts still on their first billing cycle, the timing
  clusters at **20-45 days after signup** — i.e. right around the renewal
  charge, not the ~1-week-after-purchase window a "customer got the
  product and didn't like it" story would predict. This **confirms** the
  meeting's revised read.
- **A small early-cancel cohort exists but isn't the dominant pattern.**
  ~9% of cancelled contracts (4 of 47) cancelled within 3 days of signup —
  a plausible refund/chargeback-adjacent cohort, but a minority, not "most
  cancellations." These CSVs don't carry Shopify refund/dispute status, so
  this can't be confirmed as an actual refund/chargeback — only that the
  cancellation itself was very early. Cross-referencing against Shopify's
  `financial_status` (already used elsewhere for `lastOrderRefunded`)
  would close this gap; not done yet.
- **For contracts that had already renewed at least once**, cancellation
  came a median of ~3 days (mean ~4) after their most recent successful
  charge — a tighter, more reactive pattern than the first-cycle case.
- **Cancellation reason is confirmed as an operational stockout story, not
  offer dissatisfaction, for Stripes/Beef Organs/Dewlyte:** every one of
  Bedroom Stripes' 8 cancellations carries the note "FITINHA - SEM
  ESTOQUE"; 2 of Dewlyte's 3 cancellations and 1 of Prime Organs Powder's
  2 carry "SEM ESTOQUE" / "SEM ESTOQUE DO PRODUTO". Beef Organs itself
  only shows 1 cancelled contract in this export (blank note) — the
  "spike from Beef Organs" mentioned in the meeting may be concentrated in
  a narrower window than this export's ~5-6 week history captures, or
  landed on contracts still tagged under Bundle.
- **Recalculated churn** (post test-order filtering, matching what the
  site actually shows): aggregate (any product) = 43/240 = **17.9%**.
  Bundle-only = 33/205 = **16.1%**. Excluding Bedroom Stripes + Beef
  Organs entirely = 34/215 = **15.8%**. Excluding only cancellations
  whose note matches "estoque" = 34/231 = **14.7%**. Bundle-only churn is
  close to the aggregate mainly because Bundle is ~85% of the base — the
  inflation is concentrated in the smaller products (Stripes churned
  100%, all stockout-tagged), not spread evenly. See the "Churn:
  aggregate vs. Bundle-only vs. excluding stockout" card on the
  Subscriptions page for the live, always-current version of this
  comparison (it recomputes from whatever Appstle export is loaded, so
  these exact percentages will drift as newer exports get dropped in).
- **The `cancellation_reason` field of the export is empty on every row**
  (100% blank) — only the free-text `cancellation_note` field carries any
  signal (e.g. "SEM ESTOQUE", "Cliente solicitou."). `isStockoutCancellation()`
  in `metricsEngine.ts` matches on `/estoque/i` in that note field.
- **Dunning funnel sample is small and recent-only**: the
  success/failed/skipped-dunning exports covered ~5-6 weeks (late
  June-early Aug 2026) with only 6 failed + 9 skipped-dunning rows total.
  Directionally, ~33% of failed-payment contracts (2/6) and ~22% of
  skipped-dunning contracts (2/9) were cancelled as of this export — too
  small a sample for a reliable recovery-rate number; treat
  `computeDunningFunnel`'s output as illustrative until a wider export is
  pulled.
