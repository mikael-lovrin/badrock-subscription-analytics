import { formatRelativeTime } from "../lib/format";

interface PageHeaderProps {
  title: string;
  description?: string;
  generatedAt?: string;
}

export function PageHeader({ title, description, generatedAt }: PageHeaderProps) {
  return (
    <div className="mb-6 flex items-start justify-between">
      <div>
        <h1 className="text-xl font-semibold text-gray-900">{title}</h1>
        {description && <p className="mt-1 text-sm text-gray-500">{description}</p>}
      </div>
      {generatedAt && (
        <div className="flex items-center gap-1.5 rounded-full border border-gray-200 bg-white px-3 py-1 text-xs text-gray-500">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
          Data as of {formatRelativeTime(generatedAt)}
        </div>
      )}
    </div>
  );
}
