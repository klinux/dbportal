import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

/**
 * The heading every admin section opens with: an icon in the brand colour, the section's
 * name, one sentence on what the page is for, and the actions that apply to the whole
 * section on the right. One component rather than a heading per tab so the seven sections
 * cannot drift to seven heading sizes - which is how the datasources page came to open with
 * a bold 14px line, approvals with a 16px one and monitoring with a bar of its own.
 */
export function AdminSectionHeader({
  icon: Icon,
  title,
  description,
  actions,
  testId,
}: {
  icon: LucideIcon;
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  testId?: string;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3" data-testid={testId ?? "admin-section-header"}>
      <div className="min-w-0">
        <h2 className="text-base font-medium text-fg-primary flex items-center gap-2">
          <Icon className="h-4 w-4 text-brand" strokeWidth={1.75} />
          {title}
        </h2>
        {description && <p className="text-xs text-fg-tertiary mt-1 max-w-2xl leading-relaxed">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
