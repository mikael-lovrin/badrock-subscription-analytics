import type { ReactNode } from "react";

interface CardProps {
  title?: string;
  subtitle?: string;
  children: ReactNode;
  className?: string;
}

export function Card({ title, subtitle, children, className = "" }: CardProps) {
  return (
    <div className={`rounded-lg border border-gray-200 bg-white p-5 shadow-sm ${className}`}>
      {title && (
        <div className="mb-4">
          <h3 className="text-sm font-semibold text-gray-900">{title}</h3>
          {subtitle && <p className="mt-0.5 text-xs text-gray-500">{subtitle}</p>}
        </div>
      )}
      {children}
    </div>
  );
}
