/**
 * The sub-tab row inside an admin section (Security, Audit, the datasources page's
 * environments, the monitoring dashboard): a hairline underneath, the active tab marked by
 * a brand-coloured bottom border and brand text, everything else muted. One pair of
 * strings so a fourth section cannot arrive with a fifth style of tab.
 */
export const ADMIN_SUBTAB_LIST_CLASS =
  "bg-transparent border-b border-hairline rounded-none p-0 h-10 w-full justify-start overflow-x-auto overflow-y-hidden";

/*
 * Every side but the bottom is unbordered, and the dark-theme variants the base component
 * carries for its boxed look (`dark:data-[state=active]:border-input`, `bg-input/30`) are
 * overridden by name: they survive the class merge because they are a different variant,
 * and without these the active tab renders as a filled, rounded box on the dark theme.
 */
export const ADMIN_SUBTAB_TRIGGER_CLASS =
  "flex-none gap-2 rounded-none shadow-none border-0 border-b-2 border-transparent h-full " +
  "data-[state=active]:border-b-brand data-[state=active]:bg-transparent data-[state=active]:text-brand data-[state=active]:shadow-none " +
  "dark:data-[state=active]:border-transparent dark:data-[state=active]:border-b-brand dark:data-[state=active]:bg-transparent dark:data-[state=active]:text-brand " +
  "text-fg-muted text-xs px-4 whitespace-nowrap";
