/**
 * The sub-tab row inside an admin section (Security, Audit, the datasources page's
 * environments, the monitoring dashboard): a hairline underneath, the active tab marked by
 * a brand-coloured bottom border and brand text, everything else muted. One pair of
 * strings so a fourth section cannot arrive with a fifth style of tab.
 */
export const ADMIN_SUBTAB_LIST_CLASS =
  "bg-transparent border-b border-hairline rounded-none p-0 h-10 w-full justify-start overflow-x-auto";

export const ADMIN_SUBTAB_TRIGGER_CLASS =
  "flex-none gap-2 rounded-none border-b-2 border-transparent data-[state=active]:border-b-brand data-[state=active]:bg-transparent data-[state=active]:text-brand data-[state=active]:shadow-none text-fg-muted text-xs px-4 whitespace-nowrap";
