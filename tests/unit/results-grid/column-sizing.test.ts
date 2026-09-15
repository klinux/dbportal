import { describe, test, expect } from "bun:test";
import {
  CELL_PADDING_PX,
  CHAR_PX,
  COLUMN_FIT_MAX_PX,
  COLUMN_MAX_PX,
  COLUMN_MIN_PX,
  HEADER_CONTROLS_PX,
  SAMPLE_ROWS,
  fillWidth,
  fitColumn,
  fitColumns,
} from "@/components/results-grid/column-sizing";

/**
 * Result column widths (docs/CONTEXT.md §4.42): a column is as wide as the wider of its
 * header and its sampled values, never narrower than the floor nor wider than the fit
 * ceiling; the sample is bounded so a hundred-thousand-row result is not walked; and the
 * columns are stretched to the grid's width in proportion when they fall short of it, and
 * left alone when they exceed it or the width is unknown.
 */
describe("result column sizing", () => {
  test("a column is the wider of its header and its values, between the floor and the fit ceiling", () => {
    const rows = [
      { id: 1, name: "Alice" },
      { id: 22, name: "A much longer name than the first" },
    ];
    const headerOf = (field: string) => Math.round(field.length * CHAR_PX + CELL_PADDING_PX + HEADER_CONTROLS_PX);
    // Short values: the header, with room for its sort and filter controls, is what counts.
    expect(fitColumn("id", rows)).toBe(headerOf("id"));
    expect(fitColumn("a", [{ a: 1 }])).toBe(COLUMN_MIN_PX);
    const longest = "A much longer name than the first".length;
    expect(fitColumn("name", rows)).toBe(Math.round(longest * CHAR_PX + CELL_PADDING_PX));
    // A header with a declared type is what sets the width when the values are short.
    const header = ("id".length + "timestamptz".length * 0.85 + 1) * CHAR_PX + CELL_PADDING_PX + HEADER_CONTROLS_PX;
    expect(fitColumn("id", rows, "timestamptz")).toBe(Math.round(header));
    expect(fitColumn("blob", [{ blob: "x".repeat(400) }])).toBe(COLUMN_FIT_MAX_PX);
    // A missing value formats as its own short word, not as a crash.
    expect(fitColumn("gone", [{ other: 1 }])).toBe(headerOf("gone"));
  });

  test("the sample is bounded: a long value past it does not widen the column", () => {
    const rows = Array.from({ length: SAMPLE_ROWS + 1 }, (_, i) => ({ v: i === SAMPLE_ROWS ? "y".repeat(60) : "x" }));
    expect(fitColumn("v", rows)).toBe(COLUMN_MIN_PX);
    rows[0] = { v: "y".repeat(60) };
    expect(fitColumn("v", rows)).toBe(Math.round(60 * CHAR_PX + CELL_PADDING_PX));
  });

  test("fitColumns sizes every field with its declared type", () => {
    const sizing = fitColumns(["id", "name"], [{ id: 1, name: "Alice" }], { id: "integer" });
    expect(Object.keys(sizing)).toEqual(["id", "name"]);
    expect(sizing.id).toBe(fitColumn("id", [{ id: 1 }], "integer"));
  });

  test("fillWidth stretches columns in proportion to the grid's width, exactly, and leaves a wider set or an unknown width alone", () => {
    const filled = fillWidth({ a: 100, b: 300 }, 1000);
    expect(filled).toEqual({ a: 250, b: 750 });
    expect(fillWidth({ a: 100, b: 300 }, 0)).toEqual({ a: 100, b: 300 });
    expect(fillWidth({ a: 600, b: 600 }, 1000)).toEqual({ a: 600, b: 600 });
    expect(fillWidth({}, 1000)).toEqual({});
    // Rounding never leaves a gap: the last column takes what is left.
    const odd = fillWidth({ a: 100, b: 100, c: 100 }, 1000);
    expect(odd.a + odd.b + odd.c).toBe(1000);
    // Nor does one column swallow a huge grid: the ceiling holds.
    expect(fillWidth({ a: 100 }, 5000).a).toBe(COLUMN_MAX_PX);
  });
});
