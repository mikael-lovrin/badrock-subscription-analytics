import { createContext, useContext, type ReactNode } from "react";
import { useRawData, type RawData } from "./useRawData";

type RawDataState = { status: "loading" } | { status: "error"; error: string } | { status: "ready"; data: RawData };

const RawDataContext = createContext<RawDataState | null>(null);

/** Fetches orders/customers/meta once at the app root and makes them
 * available to every page via useRawDataContext() — avoids each page
 * re-fetching the same ~350 orders independently. */
export function RawDataProvider({ children }: { children: ReactNode }) {
  const state = useRawData();
  return <RawDataContext.Provider value={state}>{children}</RawDataContext.Provider>;
}

export function useRawDataContext(): RawDataState {
  const ctx = useContext(RawDataContext);
  if (!ctx) throw new Error("useRawDataContext must be used within a RawDataProvider");
  return ctx;
}
