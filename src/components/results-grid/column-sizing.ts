import { formatCellValue } from "./utils";

/**
 * How wide each result column starts (docs/CONTEXT.md §4.42): the widest of its header and
 * of its values in a sample of rows, in a monospace column of CHAR_PX per character, held
 * between a floor and a ceiling; and, when the columns together are narrower than the grid,
 * every one stretched in proportion so the grid is used edge to edge. A person's drag
 * replaces this for the tab; a double-click on a handle fits that column to its content
 * again. Pure, so the numbers are tested without a browser.
 */
export const COLUMN_MIN_PX = 80;
export const COLUMN_FIT_MAX_PX = 500;
export const COLUMN_MAX_PX = 2_000;
export const CHAR_PX = 7.2;
export const CELL_PADDING_PX = 32;
/** The sort and filter buttons and the gap the header keeps beside the name. */
export const HEADER_CONTROLS_PX = 36;
export const SAMPLE_ROWS = 200;

export type ColumnSizing = Record<string, number>;

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/** The width one column needs for its header and its sampled values. */
export function fitColumn(field: string, rows: Record<string, unknown>[], declaredType?: string): number {
  const header =
    (field.length + (declaredType ? declaredType.length * 0.85 + 1 : 0)) * CHAR_PX +
    CELL_PADDING_PX +
    HEADER_CONTROLS_PX;
  let longest = 0;
  const sample = rows.length > SAMPLE_ROWS ? rows.slice(0, SAMPLE_ROWS) : rows;
  for (const row of sample) {
    const { display } = formatCellValue(Object.hasOwn(row, field) ? row[field] : undefined);
    if (display.length > longest) longest = display.length;
  }
  const cell = longest * CHAR_PX + CELL_PADDING_PX;
  return Math.round(clamp(Math.max(header, cell), COLUMN_MIN_PX, COLUMN_FIT_MAX_PX));
}

/** Every column fitted to its content. */
export function fitColumns(
  fields: string[],
  rows: Record<string, unknown>[],
  columnTypes?: Record<string, string>,
): ColumnSizing {
  const sizing: ColumnSizing = {};
  for (const field of fields) {
    const declared = columnTypes !== undefined && Object.hasOwn(columnTypes, field) ? columnTypes[field] : undefined;
    sizing[field] = fitColumn(field, rows, declared);
  }
  return sizing;
}

/**
 * The columns stretched in proportion to fill `containerWidth` when they fall short of it;
 * untouched when they already exceed it (the grid scrolls) or when the width is unknown.
 */
export function fillWidth(sizing: ColumnSizing, containerWidth: number): ColumnSizing {
  const fields = Object.keys(sizing);
  const total = fields.reduce((sum, f) => sum + sizing[f], 0);
  if (fields.length === 0 || containerWidth <= 0 || total >= containerWidth) return sizing;
  const factor = containerWidth / total;
  const filled: ColumnSizing = {};
  let used = 0;
  for (const [i, field] of fields.entries()) {
    // The last column takes what rounding left, so the sum is the container's width exactly.
    const size =
      i === fields.length - 1 ? containerWidth - used : Math.min(COLUMN_MAX_PX, Math.floor(sizing[field] * factor));
    filled[field] = Math.min(COLUMN_MAX_PX, size);
    used += filled[field];
  }
  return filled;
}
