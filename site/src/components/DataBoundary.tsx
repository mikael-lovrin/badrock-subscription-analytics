import type { ReactNode } from "react";
import type { Envelope } from "../lib/types";

type LoadState<T> =
  | { status: "loading" }
  | { status: "error"; error: string }
  | { status: "ready"; envelope: Envelope<T> };

interface DataBoundaryProps<T> {
  state: LoadState<T>;
  children: (data: T, generatedAt: string) => ReactNode;
}

/**
 * Shared loading/error/ready branching for every page — keeps pages from
 * repeating the same three-state switch on every useJson() call.
 */
export function DataBoundary<T>({ state, children }: DataBoundaryProps<T>) {
  if (state.status === "loading") {
    return <div className="py-16 text-center text-sm text-gray-400">Loading data...</div>;
  }
  if (state.status === "error") {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
        Failed to load data: {state.error}
      </div>
    );
  }
  return <>{children(state.envelope.data, state.envelope.generated_at)}</>;
}
