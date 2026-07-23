import type { ReactNode } from "react";
import { NavLink } from "react-router-dom";

const NAV_ITEMS = [
  { to: "/", label: "Overview", end: true },
  { to: "/subscriptions", label: "Subscriptions" },
  { to: "/products", label: "Products & Upsell" },
  { to: "/customers", label: "Customer Intelligence" },
];

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
      <main className="flex-1 px-8 py-8">{children}</main>
    </div>
  );
}
