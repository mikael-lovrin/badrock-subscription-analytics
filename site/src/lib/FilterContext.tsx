import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

export interface DateRange {
  /** Inclusive, "YYYY-MM-DD". null means unbounded on that side. */
  from: string | null;
  to: string | null;
}

interface FilterState {
  /** null means "all products" (unfiltered). Empty set is treated the
   * same as null by consumers — see metricsEngine's matchesProducts(). */
  selectedProducts: Set<string> | null;
  setSelectedProducts: (products: Set<string> | null) => void;
  dateRange: DateRange;
  setDateRange: (range: DateRange) => void;
}

/**
 * The 4 product categories Mikael actually wants to filter/compare by in
 * the UI (added 2026-08-04, replacing the old ad-hoc "All products /
 * Bundle only" toggle that used to live locally on the Subscriptions page
 * — see git history). This is the ONE place that groups raw SKU names
 * into user-facing categories; every picker (the header's global
 * multi-select) should build off this list rather than listing
 * `meta.json`'s raw product strings directly, so a future SKU rename/split
 * only needs updating here.
 *
 * "Prime Organs" deliberately aggregates the Caps/Powder variants —
 * Mikael asked for "Prime Organs" (singular, no Caps/Powder distinction)
 * in this filter; the underlying data still keeps the two as separate
 * canonical product strings (see etl/load.py's _PRODUCT_ALIASES), this is
 * purely a display/selection grouping. Selecting the "Prime Organs" entry
 * adds/removes BOTH underlying SKU strings to/from `selectedProducts`
 * together.
 */
export const PRODUCT_CATEGORIES: { label: string; skus: string[] }[] = [
  { label: "Bedroom Bundle", skus: ["Bedroom Bundle"] },
  { label: "Bedroom Stripes", skus: ["Bedroom Stripes"] },
  { label: "Beef Organs", skus: ["Beef Organs"] },
  { label: "Prime Organs", skus: ["Prime Organs Caps", "Prime Organs Powder"] },
];

const FilterContext = createContext<FilterState | null>(null);

export function FilterProvider({ children }: { children: ReactNode }) {
  const [selectedProducts, setSelectedProducts] = useState<Set<string> | null>(null);
  const [dateRange, setDateRange] = useState<DateRange>({ from: null, to: null });

  const value = useMemo(
    () => ({ selectedProducts, setSelectedProducts, dateRange, setDateRange }),
    [selectedProducts, dateRange],
  );

  return <FilterContext.Provider value={value}>{children}</FilterContext.Provider>;
}

export function useFilters(): FilterState {
  const ctx = useContext(FilterContext);
  if (!ctx) throw new Error("useFilters must be used within a FilterProvider");
  return ctx;
}
