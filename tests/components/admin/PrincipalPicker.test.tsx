import "../../setup-dom";
import { describe, test, expect, mock, afterEach } from "bun:test";
import { render, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { mockGlobalFetch, restoreGlobalFetch } from "../../helpers/mock-fetch";
import { PrincipalPicker, completeTyped } from "@/components/admin/PrincipalPicker";

/**
 * The principal picker (docs/CONTEXT.md §4.37): the chips are the value, the popover lists
 * what the deployment knows of the kinds allowed, and a typed one is added in the kind's
 * own shape.
 */
const known = [
  { id: "*", kind: "wildcard", source: "built-in" },
  { id: "admin", kind: "role", source: "built-in" },
  { id: "role:oncall", kind: "named", source: "role On-call" },
  { id: "group:sre", kind: "group", source: "role On-call" },
  { id: "user:ana@example.test", kind: "user", source: "role On-call" },
];

describe("PrincipalPicker", () => {
  afterEach(() => {
    cleanup();
    restoreGlobalFetch();
  });

  test("completeTyped takes a shaped principal of an allowed kind, and shapes a bare name by the first kind allowed", () => {
    expect(completeTyped("group:sre", ["group"])).toBe("group:sre");
    expect(completeTyped("group:sre", ["user"])).toBeNull();
    expect(completeTyped("sre", ["group", "named"])).toBe("group:sre");
    expect(completeTyped("ana", ["user"])).toBe("user:ana");
    expect(completeTyped("oncall", ["named"])).toBe("role:oncall");
    expect(completeTyped("two words", ["group"])).toBeNull();
    expect(completeTyped("  ", ["group"])).toBeNull();
    expect(completeTyped("x", ["wildcard", "role"])).toBeNull();
  });

  test("chips are removable; the popover offers only the kinds allowed, and a typed one is added shaped", async () => {
    mockGlobalFetch({ "/api/admin/principals": { ok: true, json: { principals: known } } });
    const onChange = mock((_next: string[]) => {});
    const view = render(
      <PrincipalPicker
        value={["group:dba"]}
        onChange={onChange}
        kinds={["group", "named"]}
        idPrefix="t"
        label="Add one"
      />,
    );
    expect(view.getByTestId("t-chip-group:dba")).not.toBeNull();
    fireEvent.click(view.getByLabelText("Remove group:dba"));
    expect(onChange).toHaveBeenLastCalledWith([]);
    fireEvent.click(view.getByTestId("t-add"));
    await waitFor(() => {
      if (!view.queryByTestId("t-option-group:sre")) throw new Error("not yet");
    });
    expect(view.queryByTestId("t-option-role:oncall")).not.toBeNull();
    expect(view.queryByTestId("t-option-admin")).toBeNull();
    expect(view.queryByTestId("t-option-user:ana@example.test")).toBeNull();
    fireEvent.click(view.getByTestId("t-option-group:sre"));
    expect(onChange).toHaveBeenLastCalledWith(["group:dba", "group:sre"]);
    fireEvent.click(view.getByTestId("t-add"));
    const input = view.container.ownerDocument.querySelector("[cmdk-input]") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "data-platform" } });
    await waitFor(() => {
      if (!view.queryByTestId("t-add-typed")) throw new Error("not yet");
    });
    expect(view.getByTestId("t-add-typed").textContent).toContain("group:data-platform");
    fireEvent.click(view.getByTestId("t-add-typed"));
    expect(onChange).toHaveBeenLastCalledWith(["group:dba", "group:data-platform"]);
  });
});
