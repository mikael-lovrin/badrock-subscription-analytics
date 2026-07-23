import { useEffect, useState } from "react";
import type { CustomersPayload, MetaPayload, OrdersPayload } from "./rawTypes";

export interface RawData {
  generatedAt: string;
  orders: OrdersPayload["orders"];
  lineItems: OrdersPayload["line_items"];
  customers: CustomersPayload["customers"];
  products: string[];
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
    ])
      .then(([ordersPayload, customersPayload, metaPayload]) => {
        setState({
          status: "ready",
          data: {
            generatedAt: ordersPayload.generated_at,
            orders: ordersPayload.orders,
            lineItems: ordersPayload.line_items,
            customers: customersPayload.customers,
            products: metaPayload.products,
          },
        });
      })
      .catch((err: Error) => setState({ status: "error", error: err.message }));
  }, []);

  return state;
}
