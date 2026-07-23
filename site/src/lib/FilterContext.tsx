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
