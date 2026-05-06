import { ReactNode } from "react";

export function PageHeader({
  title,
  subtitle,
  actions,
  showLogo = false,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  showLogo?: boolean;
}) {
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between border-b bg-surface px-6 py-5">
      <div>
        <h1 className="text-2xl font-semibold text-foreground">{title}</h1>
        {subtitle && (
          <p className="text-sm text-muted-foreground mt-1">{subtitle}</p>
        )}
      </div>
      <div className="flex flex-col sm:flex-row sm:items-center gap-4 shrink-0">
        {actions && <div className="flex items-center gap-2">{actions}</div>}
        {showLogo && (
          <img
            src="/header-logo.png"
            alt="Carbon Car Care"
            className="h-8 w-auto object-contain hidden md:block opacity-90 hover:opacity-100 transition-opacity"
          />
        )}
      </div>
    </div>
  );
}
