import { useEffect, useRef, useState, type ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { useFilters } from "../lib/FilterContext";
import { useRawDataContext } from "../lib/RawDataContext";

const NAV_ITEMS = [
  { to: "/", label: "Overview", end: true },
  { to: "/subscriptions", label: "Subscriptions" },
  { to: "/products", label: "Products & Upsell" },
  { to: "/customers", label: "Customer Intelligence" },
];

function useClickOutside<T extends HTMLElement>(onOutside: () => void) {
  const ref = useRef<T>(null);
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onOutside();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onOutside]);
  return ref;
}

function ProductMultiSelect() {
  const raw = useRawDataContext();
  const { selectedProducts, setSelectedProducts } = useFilters();
  const [open, setOpen] = useState(false);
  const ref = useClickOutside<HTMLDivElement>(() => setOpen(false));

  const products = raw.status === "ready" ? raw.data.products : [];
  const isAll = selectedProducts === null || selectedProducts.size === 0;
  const label = isAll ? "All products" : selectedProducts.size === 1 ? [...selectedProducts][0] : `${selectedProducts.size} products`;

  const toggle = (product: string) => {
    const next = new Set(selectedProducts ?? []);
    if (next.has(product)) next.delete(product);
    else next.add(product);
    setSelectedProducts(next.size === 0 ? null : next);
  };

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex min-w-[10rem] items-center justify-between gap-2 rounded-md border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-700 shadow-sm hover:border-gray-300 focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
      >
        <span className="truncate">{label}</span>
        <span className="text-gray-400">▾</span>
      </button>
      {open && (
        <div className="absolute right-0 z-10 mt-1 w-64 rounded-md border border-gray-200 bg-white p-2 shadow-lg">
          <button
            type="button"
            onClick={() => setSelectedProducts(null)}
            className={`mb-1 w-full rounded px-2 py-1.5 text-left text-sm ${isAll ? "bg-brand/10 text-brand-dark font-medium" : "text-gray-600 hover:bg-gray-50"}`}
          >
            All products
          </button>
          <div className="max-h-64 overflow-y-auto">
            {products.map((p) => (
              <label key={p} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-gray-700 hover:bg-gray-50">
                <input type="checkbox" checked={selectedProducts?.has(p) ?? false} onChange={() => toggle(p)} className="accent-brand" />
                {p}
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function DateRangeControl() {
  const { dateRange, setDateRange } = useFilters();
  return (
    <div className="flex items-center gap-1.5">
      <input
        type="date"
        value={dateRange.from ?? ""}
        onChange={(e) => setDateRange({ ...dateRange, from: e.target.value || null })}
        className="rounded-md border border-gray-200 bg-white px-2 py-1.5 text-sm text-gray-700 shadow-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
        aria-label="From date"
      />
      <span className="text-gray-400">–</span>
      <input
        type="date"
        value={dateRange.to ?? ""}
        onChange={(e) => setDateRange({ ...dateRange, to: e.target.value || null })}
        className="rounded-md border border-gray-200 bg-white px-2 py-1.5 text-sm text-gray-700 shadow-sm focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
        aria-label="To date"
      />
      {(dateRange.from || dateRange.to) && (
        <button
          type="button"
          onClick={() => setDateRange({ from: null, to: null })}
          className="text-xs text-gray-400 hover:text-gray-600"
          title="Clear date range"
        >
          Clear
        </button>
      )}
    </div>
  );
}

export function Layout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen">
      <aside className="w-60 shrink-0 border-r border-gray-200 bg-white">
        <div className="flex h-16 items-center gap-2 border-b border-gray-200 px-5">
          <span className="h-2 w-2 rounded-full bg-brand" />
          <span className="text-sm font-semibold tracking-tight text-gray-900">BADROCK</span>
          <span className="text-xs text-gray-400">Analytics</span>
        </div>
        <nav className="flex flex-col gap-0.5 p-3">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                `rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                  isActive
                    ? "bg-brand/10 text-brand-dark"
                    : "text-gray-600 hover:bg-gray-100 hover:text-gray-900"
                }`
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
      </aside>
      <div className="flex-1">
        <header className="flex h-16 flex-wrap items-center justify-end gap-3 border-b border-gray-200 bg-white px-8">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium uppercase tracking-wide text-gray-400">Dates</span>
            <DateRangeControl />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium uppercase tracking-wide text-gray-400">Product</span>
            <ProductMultiSelect />
          </div>
        </header>
        <main className="px-8 py-8">{children}</main>
      </div>
    </div>
  );
}
