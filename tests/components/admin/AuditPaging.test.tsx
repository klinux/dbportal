import "../../setup-dom";
import { describe, test, expect, mock, afterEach } from "bun:test";
import { render, fireEvent, cleanup } from "@testing-library/react";
import {
  AuditFilters,
  AuditPager,
  EMPTY_AUDIT_FILTERS,
  auditPageParams,
  toInstantParam,
} from "@/components/admin/AuditPaging";

/** The Audit page's filters and pager (docs/CONTEXT.md §4.27): what they ask, and the query string they make. */
describe("AuditPaging", () => {
  afterEach(() => cleanup());

  test("the filters hand every keystroke up, and the query string carries only what is set", () => {
    const onChange = mock((_next: typeof EMPTY_AUDIT_FILTERS) => {});
    const { getByLabelText } = render(<AuditFilters values={EMPTY_AUDIT_FILTERS} onChange={onChange} idPrefix="t" />);
    fireEvent.change(getByLabelText("Actor"), { target: { value: "ana" } });
    expect(onChange).toHaveBeenLastCalledWith({ ...EMPTY_AUDIT_FILTERS, actor: "ana" });
    fireEvent.change(getByLabelText("Datasource"), { target: { value: "Orders" } });
    fireEvent.change(getByLabelText("From"), { target: { value: "2026-09-14T09:00" } });
    fireEvent.change(getByLabelText("To"), { target: { value: "2026-09-14T12:00" } });
    expect(onChange).toHaveBeenCalledTimes(4);
    const params = auditPageParams({
      type: "maintenance",
      filters: { actor: " ana ", connection: "", from: "2026-09-14T09:00", to: "nonsense" },
      limit: 100,
      offset: 200,
    });
    expect(params.get("type")).toBe("maintenance");
    expect(params.get("actor")).toBe("ana");
    expect(params.has("connection")).toBe(false);
    expect(params.get("from")).toBe(toInstantParam("2026-09-14T09:00") ?? null);
    expect(params.has("to")).toBe(false);
    expect(params.get("limit")).toBe("100");
    expect(params.get("offset")).toBe("200");
    expect(auditPageParams({ type: "all", filters: EMPTY_AUDIT_FILTERS, limit: 10, offset: 0 }).has("type")).toBe(
      false,
    );
    expect(toInstantParam("")).toBeUndefined();
  });

  test("the pager says the range and moves by a page, never before the first or past the last", () => {
    const onPage = mock(() => {});
    const { getByTestId, getByLabelText, rerender } = render(
      <AuditPager offset={100} limit={100} total={250} shown={100} onPage={onPage} idPrefix="t" />,
    );
    expect(getByTestId("t-page-range").textContent).toBe("101–200 of 250");
    fireEvent.click(getByLabelText("Previous page"));
    expect(onPage).toHaveBeenLastCalledWith(0);
    fireEvent.click(getByLabelText("Next page"));
    expect(onPage).toHaveBeenLastCalledWith(200);
    rerender(<AuditPager offset={200} limit={100} total={250} shown={50} onPage={onPage} idPrefix="t" />);
    expect(getByTestId("t-page-range").textContent).toBe("201–250 of 250");
    expect((getByLabelText("Next page") as HTMLButtonElement).disabled).toBe(true);
    rerender(<AuditPager offset={0} limit={100} total={0} shown={0} onPage={onPage} idPrefix="t" />);
    expect(getByTestId("t-page-range").textContent).toBe("0–0 of 0");
    expect((getByLabelText("Previous page") as HTMLButtonElement).disabled).toBe(true);
  });
});
