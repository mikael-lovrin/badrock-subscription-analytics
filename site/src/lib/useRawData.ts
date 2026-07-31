import { useEffect, useState } from "react";
import type { AppstleSubscriptionsPayload, CustomersPayload, MetaPayload, OrdersPayload, RawAppstleSubscription } from "./rawTypes";

export interface RawData {
  generatedAt: string;
  orders: OrdersPayload["orders"];
  lineItems: OrdersPayload["line_items"];
  customers: CustomersPayload["customers"];
  products: string[];
  appstleSubscriptions: RawAppstleSubscription[];
  /** Filename of the Appstle CSV the ETL last parsed, or null if none has
   * ever been dropped in etl/manual-exports/ — surfaced in the UI so it's
   * obvious how stale (or absent) the real-status cross-check is. */
  appstleSourceFile: string | null;
  /** When the Appstle data was actually captured — can lag well behind
   * generatedAt, since it only refreshes when Mikael reruns the ETL
   * locally with a fresh CSV (see etl/appstle_csv.py). */
  appstleCapturedAt: string | null;
}

type RawDataState = { status: "loading" } | { status: "error"; error: string } | { status: "ready"; data: RawData };

async function fetchJson<T>(fileName: string): Promise<T> {
  const cacheBust = new Date().toISOString().slice(0, 13); // hour bucket, matches the ETL's refresh cadence
  const url = `${import.meta.env.BASE_URL}data/${fileName}?h=${cacheBust}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${fileName}: ${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

/**
 * Fetches all three raw JSON exports once and combines them. Every page
 * uses this same hook (see App.tsx, which loads it once at the top and
 * passes it down) so the ~350 orders / ~450 customers only cross the
 * network a single time per session, not once per page.
 */
export function useRawData(): RawDataState {
  const [state, setState] = useState<RawDataState>({ status: "loading" });

  useEffect(() => {
    Promise.all([
      fetchJson<OrdersPayload>("orders.json"),
      fetchJson<CustomersPayload>("customers.json"),
      fetchJson<MetaPayload>("meta.json"),
      // Tolerate this one missing entirely (older deployments, or a brand
      // that's never had an Appstle CSV dropped in) rather than failing
      // the whole page — Shopify-only inference still works without it.
      fetchJson<AppstleSubscriptionsPayload>("appstle_subscriptions.json").catch(
        () => ({ generated_at: "", captured_at: null, source_file: null, subscriptions: [] }) as AppstleSubscriptionsPayload,
      ),
    ])
      .then(([ordersPayload, customersPayload, metaPayload, appstlePayload]) => {
        setState({
          status: "ready",
          data: {
            generatedAt: ordersPayload.generated_at,
            orders: ordersPayload.orders,
            lineItems: ordersPayload.line_items,
            customers: customersPayload.customers,
            products: metaPayload.products,
            appstleSubscriptions: appstlePayload.subscriptions,
            appstleSourceFile: appstlePayload.source_file,
            appstleCapturedAt: appstlePayload.captured_at,
          },
        });
      })
      .catch((err: Error) => setState({ status: "error", error: err.message }));
  }, []);

  return state;
}
