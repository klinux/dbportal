/**
 * The frame every configuration editor opens in (docs/CONTEXT.md §4.8): a sheet anchored to
 * the right edge at half the viewport, full height. One string rather than a class per
 * dialog so the connection, create-table and import editors cannot drift to three widths.
 *
 * Half, not the sheet primitive's `sm:max-w-sm` default: these are long forms, and the
 * width is what keeps the list they were opened from visible beside them. Full width under
 * the `sm` breakpoint, where a half-width column would leave no room for a form at all.
 * Padding is left to the caller: two editors lay out their own header and sticky footer,
 * one relies on the frame's padding.
 */
export const CONFIG_SHEET_CLASS =
  "w-full sm:w-1/2 sm:max-w-[50vw] bg-surface border-hairline-strong text-fg overflow-hidden flex flex-col";
