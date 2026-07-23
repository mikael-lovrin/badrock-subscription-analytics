import type { ReactNode } from "react";
import { useRawDataContext } from "../lib/RawDataContext";
import type { RawData } from "../lib/useRawData";

interface DataBoundaryProps {
  children: (data: RawData) => ReactNode;
}

/**
 * Loading/error/ready branching for the single raw-data fetch (see
 * RawDataContext) every page depends on — pages compute their own metrics
 * from `data` via metricsEngine.ts once this resolves.
 */
export function DataBoundary({ children }: DataBoundaryProps) {
  const state = useRawDataContext();

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
  return <>{children(state.data)}</>;
}
