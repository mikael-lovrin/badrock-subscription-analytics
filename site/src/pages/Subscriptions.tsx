import { useMemo } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { AppstleEarlyChurnCohort } from "../components/AppstleEarlyChurnCohort";
import { CancellationTimingChart } from "../components/CancellationTimingChart";
import { Card } from "../components/Card";
import { CohortHeatmap } from "../components/CohortHeatmap";
import { DataBoundary } from "../components/DataBoundary";
import { KpiCard } from "../components/KpiCard";
import { PageHeader } from "../components/PageHeader";
import { useFilters } from "../lib/FilterContext";
import { formatCurrency, formatNumber, formatPercent, formatPlanLabel } from "../lib/format";
import {
  buildContracts,
  computeAppstleEarlyChurnCohort,
  computeAvgLifespan,
  computeCancellationTiming,
  computeChurnByCycle,
  computeChurnComparison,
  computeCohortRetention,
  computeDunningFunnel,
  computeLtv,
  computeMonthlyChurn,
  computeMrr,
  computePlanMix,
  computeRefundsByProduct,
  computeSkippedDunningExposure,
  computeStockoutChurnByProduct,
  computeSubscriptionRefundSummary,
  filterAppstleSubsByProduct,
  filterBillingEventsByProduct,
} from "../lib/metricsEngine";
import type { RawData } from "../lib/useRawData";

const CHART_TICK_STYLE = { fontSize: 11, fill: "#6b7280" };

function SubscriptionsContent({ data }: { data: RawData }) {
  const { selectedProducts, dateRange } = useFilters();

  const filters = { products: selectedProducts, dateRange };

  const contracts = useMemo(
    () => buildContracts(data.orders, data.lineItems, selectedProducts, data.appstleSubscriptions),
    [data.orders, data.lineItems, selectedProducts, data.appstleSubscriptions],
  );

  const refundsByProduct = useMemo(
    () => computeRefundsByProduct(data.orders, data.lineItems, filters),
    [data.orders, data.lineItems, selectedProducts, dateRange],
  );

  // Everything below joins the REAL Appstle ledger, not the Shopify
  // inference — so it needs the same product filter applied explicitly
  // (see filterAppstleSubsByProduct's doc comment: this used to silently
  // ignore the header's product picker entirely).
  const filteredAppstleSubs = useMemo(
    () => filterAppstleSubsByProduct(data.appstleSubscriptions, selectedProducts),
    [data.appstleSubscriptions, selectedProducts],
  );
  const filteredBillingEvents = useMemo(
    () => filterBillingEventsByProduct(data.appstleBillingEvents, data.appstleSubscriptions, selectedProducts),
    [data.appstleBillingEvents, data.appstleSubscriptions, selectedProducts],
  );

  const appstleEarlyChurnCohort = useMemo(
    () => computeAppstleEarlyChurnCohort(filteredAppstleSubs),
    [filteredAppstleSubs],
  );
  const cancellationTiming = useMemo(() => computeCancellationTiming(filteredAppstleSubs), [filteredAppstleSubs]);
  // Deliberately built from the FULL, unfiltered ledger — the whole point
  // of this card is comparing scopes (aggregate vs. Bundle-only vs.
  // excluding stockout noise), so it ignores the header's product picker
  // on purpose rather than being redundant with it.
  const churnComparison = useMemo(() => computeChurnComparison(data.appstleSubscriptions), [data.appstleSubscriptions]);
  const stockoutChurnByProduct = useMemo(
    () => computeStockoutChurnByProduct(data.appstleSubscriptions),
    [data.appstleSubscriptions],
  );
  const dunningFunnel = useMemo(
    () => computeDunningFunnel(filteredBillingEvents, filteredAppstleSubs),
    [filteredBillingEvents, filteredAppstleSubs],
  );
  const skippedDunningExposure = useMemo(
    () => computeSkippedDunningExposure(filteredBillingEvents, filteredAppstleSubs),
    [filteredBillingEvents, filteredAppstleSubs],
  );

  const mrr = useMemo(() => computeMrr(contracts), [contracts]);
  // "Excluding skipped-dunning": the same MRR calc, minus any ACTIVE
  // Shopify-inferred contract whose customer is currently sitting in a
  // skipped-dunning state per the real Appstle ledger — see
  // computeSkippedDunningExposure's doc comment for the join and its
  // rolling-window limitation. Shown side by side with the plain MRR
  // above rather than silently replacing it, since the join (by customer
  // email, across two independently-sourced datasets) isn't guaranteed
  // exact.
  const mrrExcludingSkippedDunning = useMemo(
    () => computeMrr(contracts, skippedDunningExposure.currentlySkippedCustomerEmails),
    [contracts, skippedDunningExposure],
  );
  const churnByCycle = useMemo(() => computeChurnByCycle(contracts, dateRange), [contracts, dateRange]);
  const monthlyChurn = useMemo(() => computeMonthlyChurn(contracts, dateRange), [contracts, dateRange]);
  const cohortRetention = useMemo(() => computeCohortRetention(contracts, dateRange), [contracts, dateRange]);
  const ltv = useMemo(() => computeLtv(contracts, dateRange), [contracts, dateRange]);
  const avgLifespan = useMemo(() => computeAvgLifespan(contracts, dateRange), [contracts, dateRange]);
  const planMix = useMemo(() => computePlanMix(contracts, dateRange), [contracts, dateRange]);
  const subscriptionRefundSummary = useMemo(
    () => computeSubscriptionRefundSummary(contracts, dateRange),
    [contracts, dateRange],
  );

  const totalSubscribers = planMix.reduce((sum, p) => sum + p.totalSubscribers, 0);
  const totalCancelled = planMix.reduce((sum, p) => sum + p.cancelledSubscribers, 0);
  const totalMatured = totalSubscribers - planMix.reduce((sum, p) => sum + p.pendingSubscribers, 0);

  return (
    <div>
      <PageHeader
        title="Subscriptions"
        description="MRR, renewal-cycle churn, cohort retention and LTV."
        generatedAt={data.generatedAt}
      />

      <div className="mb-6 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
        <p className="font-medium">Estimated, not observed</p>
        <p className="mt-1">
          Badrock's Appstle plan doesn't include API access, so these numbers are derived from Shopify order history
          instead of a real billing ledger: a subscriber counts as <strong>ACTIVE</strong> if a new order arrived
          within 1.1× their billing interval, otherwise <strong>CANCELLED</strong> as of their expected next billing
          date — inferred from renewal silence, not a real cancellation event. This can't catch a subscriber who
          cancels proactively without placing (or missing) any order — see the real Appstle cross-check below the
          plan comparison table for that.
        </p>
      </div>

      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <KpiCard
          label="MRR (incl. skipped dunning)"
          value={formatCurrency(mrr.totalMrr)}
          hint={`${mrr.totalActiveSubscribers} active subscribers — counts every non-cancelled contract as paying, including any currently in skipped dunning`}
        />
        <KpiCard
          label="MRR (excl. skipped dunning)"
          value={formatCurrency(mrrExcludingSkippedDunning.totalMrr)}
          hint={`${mrrExcludingSkippedDunning.totalActiveSubscribers} active subscribers — ${skippedDunningExposure.currentlySkippedCount} contract(s) in skipped dunning removed from both the count and the revenue. See "Skipped dunning exposure" below.`}
        />
        <KpiCard label="Avg LTV (to date)" value={formatCurrency(ltv.overallAvgLtv)} hint="Rises until the full cohort has churned" />
        <KpiCard
          label="Avg subscriber lifespan"
          value={avgLifespan.avgLifespanDays !== null ? `${Math.round(avgLifespan.avgLifespanDays)} days` : "—"}
          hint={`Based on ${avgLifespan.sampleSize} churned subscriber(s)`}
        />
      </div>
      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <KpiCard
          label="Cancellation rate"
          value={formatPercent(totalMatured ? (100 * totalCancelled) / totalMatured : 0)}
          hint={`Of ${totalMatured} subscribers past their first renewal deadline (${totalSubscribers - totalMatured} too new to count yet)`}
        />
        <KpiCard
          label="Subscriptions refunded"
          value={formatNumber(subscriptionRefundSummary.refundedSubscriptions)}
          hint={`${formatPercent(subscriptionRefundSummary.refundRatePct)} of ${subscriptionRefundSummary.totalSubscriptions} subscriptions — counts a refund only when it hit the FIRST order. A renewal that got refunded after cancellation counts as churn at that cycle instead (see "Churn by renewal cycle" below), not here.`}
        />
      </div>

      <Card
        title="Skipped dunning exposure"
        subtitle="Contracts Appstle's ledger still shows as ACTIVE, but whose most recent known billing attempt was a skip after every retry failed — not paying, but not cancelled either"
        className="mb-6"
      >
        <div className="mb-3 rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
          <p className="font-medium">What "skipped dunning" means</p>
          <p className="mt-1">
            After every retry attempt for a failed charge fails, Appstle's configured final action can be "skip"
            instead of "cancel" — the subscription stays <strong>ACTIVE</strong>, but that billing cycle was never
            actually paid. Left uncorrected, these accounts would count as normal paying subscribers in both the
            active-subscriber count and MRR above.
          </p>
          <p className="mt-1">
            <strong>Limitation:</strong> the success/failed/skipped-dunning exports this is built from only cover a
            rolling ~5-6 week window, not full history (see README) — a contract that skipped dunning further back,
            with no billing activity since, won't appear in this export at all and is invisible here. Treat the count
            below as a lower bound, not a complete count.
          </p>
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <KpiCard
            label="Currently in skipped dunning"
            value={formatNumber(skippedDunningExposure.currentlySkippedCount)}
            hint="Still ACTIVE per Appstle, but the last known billing attempt was skipped, not paid"
          />
          <KpiCard
            label="MRR removed"
            value={formatCurrency(mrr.totalMrr - mrrExcludingSkippedDunning.totalMrr)}
            hint="Difference between the two MRR figures above"
          />
          <KpiCard
            label="Subscribers removed"
            value={formatNumber(mrr.totalActiveSubscribers - mrrExcludingSkippedDunning.totalActiveSubscribers)}
            hint="Matched by customer email against the Appstle billing ledger — an approximate join, not a guaranteed-exact one"
          />
        </div>
      </Card>

      <Card title="MRR by plan" subtitle="Monthly-equivalent revenue, normalized by billing interval — includes skipped-dunning contracts (see exposure card above)" className="mb-6">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          {Object.entries(mrr.byPlan).map(([plan, breakdown]) => (
            <div key={plan} className="rounded-md border border-gray-100 p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-gray-500">{formatPlanLabel(plan)}</p>
              <p className="mt-1 text-lg font-semibold text-gray-900">{formatCurrency(breakdown.mrr)}</p>
              <p className="text-xs text-gray-400">{breakdown.activeSubscribers} active</p>
            </div>
          ))}
        </div>
      </Card>

      <div className="mb-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card title="Churn by renewal cycle" subtitle="% of subscribers who didn't renew after their renewal date arrived">
          <p className="mb-3 text-xs text-gray-500">
            "Renewal 0" = cancelled before their first renewal date ever arrived — no charge was attempted yet.
            "Renewal 1" onward = that cycle's renewal date has come and gone (whether or not the charge on it
            succeeded — see <strong>cyclesDue</strong> in metricsEngine.ts), so a subscriber whose charge was
            attempted and failed/was skipped (Appstle's "skipped dunning") but who eventually cancelled now counts as
            churn at the renewal cycle it actually happened on, instead of disappearing into "never reached a
            renewal" the way it used to. Under the new definition, 66.7% of all-time cancelled contracts cancelled
            before their first renewal date ever arrived (Renewal 0) — down from the 91% figure quoted here
            previously, which conflated "genuinely never got a renewal attempt" with "renewal attempted, failed, and
            eventually cancelled without ever formally renewing." For the full picture including day-one
            cancellations, see <strong>"Churn: aggregate vs. Bundle-only vs. excluding stockout"</strong> below.
          </p>
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={churnByCycle}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
              <XAxis dataKey="cycle" tick={CHART_TICK_STYLE} tickFormatter={(c) => `Renewal ${c}`} />
              <YAxis tick={CHART_TICK_STYLE} unit="%" />
              <Tooltip
                formatter={(value: number, name) => (name === "churnRatePct" ? [`${value}%`, "Churn rate"] : [value, name])}
                labelFormatter={(c) => `Renewal ${c}`}
              />
              <Bar dataKey="churnRatePct" fill="#CE202F" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </Card>

        <Card title="Monthly churn rate" subtitle="Cancelled this month / active at start of month">
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={monthlyChurn}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f3f4f6" />
              <XAxis dataKey="month" tick={CHART_TICK_STYLE} />
              <YAxis tick={CHART_TICK_STYLE} unit="%" />
              <Tooltip />
              <Line type="monotone" dataKey="churnRatePct" stroke="#CE202F" strokeWidth={2} dot={{ r: 3 }} />
            </LineChart>
          </ResponsiveContainer>
        </Card>
      </div>

      <Card title="Cohort retention" subtitle="% of each acquisition-month cohort still renewing at each renewal cycle" className="mb-6">
        <CohortHeatmap rows={cohortRetention} planMix={planMix} />
      </Card>

      <Card
        title="Plan comparison"
        subtitle="Monthly ($49) vs bimonthly ($88) vs trimonthly ($117). Cancellation rate is of subscribers past their first renewal deadline — see 'Pending'. Scoped to whoever acquired within the date filter above (top-right) — clear it to see all-time, or set From/To to a specific acquisition window."
      >
        <table className="min-w-full text-sm">
          <thead>
            <tr className="border-b border-gray-200 text-left text-xs font-medium uppercase text-gray-500">
              <th className="py-2">Plan</th>
              <th className="py-2 text-right">Total subscribers</th>
              <th className="py-2 text-right">Active</th>
              <th className="py-2 text-right">Cancelled</th>
              <th className="py-2 text-right">— never renewed</th>
              <th className="py-2 text-right">— refunded</th>
              <th className="py-2 text-right">Pending</th>
              <th className="py-2 text-right">Cancellation rate</th>
              <th className="py-2 text-right">Refunded orders</th>
              <th className="py-2 text-right">Refund rate</th>
              <th className="py-2 text-right">Subscriptions refunded</th>
              <th className="py-2 text-right">Avg LTV</th>
            </tr>
          </thead>
          <tbody>
            {planMix.map((row) => (
              <tr key={row.plan} className="border-b border-gray-100">
                <td className="py-2 font-medium text-gray-900">{formatPlanLabel(row.plan)}</td>
                <td className="py-2 text-right">{formatNumber(row.totalSubscribers)}</td>
                <td className="py-2 text-right">{formatNumber(row.activeSubscribers)}</td>
                <td className="py-2 text-right">{formatNumber(row.cancelledSubscribers)}</td>
                <td
                  className="py-2 text-right text-gray-500"
                  title="Just stopped ordering — no refund on their last order, plain renewal silence"
                >
                  {formatNumber(row.cancelledSilent)}
                </td>
                <td
                  className="py-2 text-right text-gray-500"
                  title="Their last order came back REFUNDED or PARTIALLY_REFUNDED — an explicit ask for money back, not silent non-renewal"
                >
                  {row.cancelledSubscribers > 0
                    ? `${formatNumber(row.cancelledRefunded)} (${formatPercent(row.refundShareOfCancelledPct)})`
                    : "—"}
                </td>
                <td className="py-2 text-right text-gray-400" title="Still on their first cycle, not yet past their renewal deadline">
                  {formatNumber(row.pendingSubscribers)}
                </td>
                <td className="py-2 text-right">
                  {formatPercent(row.cancellationRatePct)}
                  {row.totalSubscribers - row.pendingSubscribers < 5 && (
                    <span
                      className="ml-1 text-[10px] font-normal text-gray-400"
                      title={`Only ${row.totalSubscribers - row.pendingSubscribers} subscriber(s) have actually reached their first renewal deadline yet — this rate will swing wildly until that grows. Longer billing intervals (e.g. trimonthly) take longer to have anyone "mature".`}
                    >
                      (amostra pequena)
                    </span>
                  )}
                </td>
                <td
                  className="py-2 text-right text-gray-500"
                  title="All orders on this plan's contracts (not just cancelled subscribers' last order) whose payment status came back REFUNDED or PARTIALLY_REFUNDED"
                >
                  {formatNumber(row.refundedOrders)}
                </td>
                <td className="py-2 text-right">{row.totalPlanOrders > 0 ? formatPercent(row.refundRatePct) : "—"}</td>
                <td
                  className="py-2 text-right text-gray-500"
                  title="Of this plan's subscriptions, how many had their FIRST order (not a renewal) come back REFUNDED/PARTIALLY_REFUNDED"
                >
                  {row.totalSubscribers > 0
                    ? `${formatNumber(row.subscriptionsRefunded)} (${formatPercent(row.subscriptionRefundRatePct)})`
                    : "—"}
                </td>
                <td className="py-2 text-right">{row.avgLtv !== null ? formatCurrency(row.avgLtv) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <Card
        title="Appstle — cancelled before first renewal"
        subtitle={
          data.appstleSourceFile
            ? `Real Appstle status, not inferred — from ${data.appstleSourceFile}${data.appstleCapturedAt ? `, captured ${new Date(data.appstleCapturedAt).toLocaleDateString()}` : ""}. The one thing the Shopify-inference model above structurally can't see: a subscriber who cancelled without ever placing (or missing) an order.`
            : "No Appstle export available yet — drop a CSV in etl/manual-exports/ and re-run the ETL (see README) to populate this."
        }
        className="mt-6"
      >
        <AppstleEarlyChurnCohort rows={appstleEarlyChurnCohort} />
      </Card>

      <Card
        title="Real cancellation timing"
        subtitle={
          data.appstleSourceFile
            ? "When cancellations actually happen, from the real Appstle ledger — tests the 2026-08-03 meeting's hypothesis that cancellations cluster right after product delivery vs. right around the renewal date."
            : "No Appstle export available yet — drop a CSV in etl/manual-exports/ and re-run the ETL (see README) to populate this."
        }
        className="mt-6"
      >
        <div className="mb-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
          <KpiCard
            label="Cancelled within 3 days of signup"
            value={formatPercent(cancellationTiming.earlyCancelWithin3DaysPct)}
            hint={`${cancellationTiming.earlyCancelWithin3DaysCount} of ${cancellationTiming.totalCancelledWithDates} cancelled contracts — the likely refund/chargeback window (not confirmed here: these CSVs don't carry Shopify refund status)`}
          />
          <KpiCard
            label="Before 1st renewal — n"
            value={formatNumber(cancellationTiming.sinceSignupBeforeFirstRenewal.reduce((s, b) => s + b.count, 0))}
            hint="Cancelled contracts that never made it past their first billing cycle"
          />
          <KpiCard
            label="After 1st renewal — n"
            value={formatNumber(cancellationTiming.sinceSignupAfterFirstRenewal.reduce((s, b) => s + b.count, 0))}
            hint="Cancelled contracts that had already renewed at least once"
          />
        </div>
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
              Days from signup to cancellation — before 1st renewal
            </p>
            <CancellationTimingChart buckets={cancellationTiming.sinceSignupBeforeFirstRenewal} />
          </div>
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
              Days from last charge to cancellation — after 1st renewal
            </p>
            <CancellationTimingChart buckets={cancellationTiming.sinceLastOrder} />
          </div>
        </div>
        <p className="mt-3 text-xs text-gray-400">
          If cancellations were mostly a reaction to receiving the product, the left chart would spike in the first
          1-2 weeks. If it instead clusters near the 20-90 day range (roughly one billing interval), most first-cycle
          cancellations are happening at/around the renewal charge, not right after delivery.
        </p>
      </Card>

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card
          title="Churn: aggregate vs. Bundle-only vs. excluding stockout"
          subtitle="Real Appstle status. Always all-time, all-acquisition — ignores the header's product filter on purpose, since the point is comparing scopes side by side."
        >
          <table className="min-w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-left text-xs font-medium uppercase text-gray-500">
                <th className="py-2">Scope</th>
                <th className="py-2 text-right">Total</th>
                <th className="py-2 text-right">Cancelled</th>
                <th className="py-2 text-right">Churn rate</th>
              </tr>
            </thead>
            <tbody>
              {churnComparison.map((row) => (
                <tr key={row.scope} className="border-b border-gray-100">
                  <td className="py-2 font-medium text-gray-900">{row.scope}</td>
                  <td className="py-2 text-right">{formatNumber(row.totalSubscriptions)}</td>
                  <td className="py-2 text-right">{formatNumber(row.cancelled)}</td>
                  <td className="py-2 text-right font-semibold">{formatPercent(row.churnRatePct)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>

        <Card
          title="Stockout-driven cancellations, by product"
          subtitle="Cancellation notes matching 'estoque' (SEM ESTOQUE / FITINHA - SEM ESTOQUE) — the launched-without-stock operational situation, not product/offer dissatisfaction"
        >
          {stockoutChurnByProduct.length === 0 ? (
            <p className="text-sm text-gray-400">No cancelled contracts in the Appstle ledger yet.</p>
          ) : (
            <table className="min-w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-left text-xs font-medium uppercase text-gray-500">
                  <th className="py-2">Product</th>
                  <th className="py-2 text-right">Cancelled</th>
                  <th className="py-2 text-right">Stockout-tagged</th>
                  <th className="py-2 text-right">Share</th>
                </tr>
              </thead>
              <tbody>
                {stockoutChurnByProduct.map((row) => (
                  <tr key={row.product} className="border-b border-gray-100">
                    <td className="py-2 font-medium text-gray-900">{row.product}</td>
                    <td className="py-2 text-right">{formatNumber(row.totalCancelled)}</td>
                    <td className="py-2 text-right">{formatNumber(row.stockoutCancelled)}</td>
                    <td
                      className="py-2 text-right font-semibold"
                      style={{ color: row.stockoutSharePct >= 50 ? "#CE202F" : undefined }}
                    >
                      {formatPercent(row.stockoutSharePct)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>

        <Card
          title="Refunds by product"
          subtitle="Payment status REFUNDED / PARTIALLY_REFUNDED, all orders (not just subscription contracts) — respects the header's product + date filters, unlike the two cards above"
        >
          {refundsByProduct.length === 0 ? (
            <p className="text-sm text-gray-400">No orders in this scope.</p>
          ) : (
            <table className="min-w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-left text-xs font-medium uppercase text-gray-500">
                  <th className="py-2">Product</th>
                  <th className="py-2 text-right">Orders</th>
                  <th className="py-2 text-right">Refunded</th>
                  <th className="py-2 text-right">Refund rate</th>
                </tr>
              </thead>
              <tbody>
                {refundsByProduct.map((row) => (
                  <tr key={row.product} className="border-b border-gray-100">
                    <td className="py-2 font-medium text-gray-900">{row.product}</td>
                    <td className="py-2 text-right">{formatNumber(row.totalOrders)}</td>
                    <td className="py-2 text-right">{formatNumber(row.refundedOrders)}</td>
                    <td
                      className="py-2 text-right font-semibold"
                      style={{ color: row.refundRatePct >= 10 ? "#CE202F" : undefined }}
                    >
                      {formatPercent(row.refundRatePct)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>

      <Card
        title="Dunning funnel"
        subtitle={
          data.appstleBillingEventSources?.failed || data.appstleBillingEventSources?.skipped_dunning
            ? `From Appstle's success/failed/skipped-dunning past-orders exports${
                filteredBillingEvents.length !== data.appstleBillingEvents.length ? " (filtered to the selected product)" : ""
              } — only ~5-6 weeks of recent billing activity is present in these exports, treat rates as directional, not full-history.`
            : "No dunning exports available yet — drop the ANALYTICS_failed_past_orders_export / ANALYTICS_skipped_dunning_past_orders_export CSVs in etl/manual-exports/ and re-run the ETL."
        }
        className="mt-6"
      >
        <div className="mb-4 grid grid-cols-2 gap-4 lg:grid-cols-4">
          <KpiCard label="Failed attempts" value={formatNumber(dunningFunnel.failedAttempts)} />
          <KpiCard label="Skipped dunning" value={formatNumber(dunningFunnel.skippedDunning)} />
          <KpiCard
            label="Contracts affected"
            value={formatNumber(dunningFunnel.distinctContractsAffected)}
            hint="Distinct contracts with at least 1 failed or skipped-dunning attempt"
          />
          <KpiCard
            label="Now cancelled"
            value={formatPercent(dunningFunnel.cancelledSharePct)}
            hint={`${dunningFunnel.contractsNowCancelled} cancelled vs. ${dunningFunnel.contractsStillActive} still active`}
          />
        </div>
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">Top error codes</p>
            {dunningFunnel.topErrorCodes.length === 0 ? (
              <p className="text-sm text-gray-400">No failed/skipped attempts in this scope.</p>
            ) : (
              <table className="min-w-full text-sm">
                <tbody>
                  {dunningFunnel.topErrorCodes.map((row) => (
                    <tr key={row.code} className="border-b border-gray-100">
                      <td className="py-1.5 text-gray-700">{row.code}</td>
                      <td className="py-1.5 text-right font-medium text-gray-900">{row.count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">
              Attempts before a failed charge gives up
            </p>
            {dunningFunnel.attemptCountDistribution.length === 0 ? (
              <p className="text-sm text-gray-400">No failed attempts in this scope.</p>
            ) : (
              <table className="min-w-full text-sm">
                <tbody>
                  {dunningFunnel.attemptCountDistribution.map((row) => (
                    <tr key={row.attempts} className="border-b border-gray-100">
                      <td className="py-1.5 text-gray-700">Attempt {row.attempts}</td>
                      <td className="py-1.5 text-right font-medium text-gray-900">{row.count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </Card>
    </div>
  );
}

export function Subscriptions() {
  return <DataBoundary>{(data) => <SubscriptionsContent data={data} />}</DataBoundary>;
}
