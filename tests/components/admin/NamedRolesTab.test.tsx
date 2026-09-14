import "../../setup-dom";
import { mockToastSuccess, mockToastError } from "../../helpers/mock-sonner";
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { render, fireEvent, cleanup, waitFor, act, within } from "@testing-library/react";
import { mockGlobalFetch, restoreGlobalFetch } from "../../helpers/mock-fetch";
import { NamedRolesTab, parseMembers, slugifyRoleId } from "@/components/admin/tabs/NamedRolesTab";

/**
 * The named roles page (docs/CONTEXT.md §4.19): the list with each role's members and
 * source, the sheet that declares one from a name and a member list, and the delete; a
 * seed-file role cannot be deleted here.
 */
const oncall = {
  id: "oncall",
  name: "On-call",
  members: ["group:sre-oncall", "user:ana@example.test"],
  source: "store",
};
const reviewer = { id: "reviewer", name: "Reviewer", members: ["group:dba"], source: "config" };
const listing = (roles: unknown[] = [oncall, reviewer]) => ({ ok: true, json: { roles } });

async function renderLoaded() {
  const result = render(<NamedRolesTab />);
  await waitFor(() => {
    if (result.queryByTestId("named-roles-loading")) throw new Error("still loading");
  });
  return result;
}
const calls = (fetchMock: ReturnType<typeof mockGlobalFetch>, method: string) =>
  fetchMock.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method === method);

describe("NamedRolesTab", () => {
  beforeEach(() => {
    mockToastSuccess.mockClear();
    mockToastError.mockClear();
  });

  afterEach(() => {
    cleanup();
    restoreGlobalFetch();
  });

  test("lists roles with their members; a seed-file role has no delete button", async () => {
    mockGlobalFetch({ "/api/admin/roles": listing() });
    const { getByTestId } = await renderLoaded();
    const row = within(getByTestId("role-oncall"));
    expect(row.getByText("role:oncall")).not.toBeNull();
    expect(row.getByText("group:sre-oncall, user:ana@example.test")).not.toBeNull();
    expect(row.getByLabelText("Delete On-call")).not.toBeNull();
    const cfg = within(getByTestId("role-reviewer"));
    expect(cfg.getByText("seed file")).not.toBeNull();
    expect(cfg.queryByLabelText("Delete Reviewer")).toBeNull();
  });

  test("an empty list and a failed read each say so", async () => {
    mockGlobalFetch({ "/api/admin/roles": listing([]) });
    const first = await renderLoaded();
    expect(first.getByTestId("named-roles-empty")).not.toBeNull();
    cleanup();
    restoreGlobalFetch();
    mockGlobalFetch({ "/api/admin/roles": { ok: false, status: 503, json: { error: "no store" } } });
    const { findByTestId } = render(<NamedRolesTab />);
    expect((await findByTestId("named-roles-error")).textContent).toContain("no store");
  });

  test("declaring posts the id from the name and the members; a blank form is refused first", async () => {
    const fetchMock = mockGlobalFetch({
      "/api/admin/roles": (req) =>
        req.method === "POST" ? { ok: true, status: 201, json: { role: oncall } } : listing([]),
    });
    const { getByText, getByLabelText } = await renderLoaded();
    fireEvent.click(getByText("New role"));
    fireEvent.click(getByText("Declare role"));
    expect(mockToastError).toHaveBeenCalledWith("A name and at least one member are required.");
    fireEvent.change(getByLabelText("Name"), { target: { value: "On-call (EU)" } });
    expect(getByText("role:on-call-eu")).not.toBeNull();
    fireEvent.change(getByLabelText("Members (one per line)"), {
      target: { value: "group:sre-oncall\n user:ana@example.test , group:sre-oncall\n\n" },
    });
    await act(async () => {
      fireEvent.click(getByText("Declare role"));
    });
    const body = JSON.parse((calls(fetchMock, "POST")[0][1] as RequestInit).body as string);
    expect(body).toEqual({
      id: "on-call-eu",
      name: "On-call (EU)",
      members: ["group:sre-oncall", "user:ana@example.test"],
    });
    expect(mockToastSuccess).toHaveBeenCalledWith('Role "On-call (EU)" declared');
  });

  test("the server's refusal of a declaration is shown in its words", async () => {
    mockGlobalFetch({
      "/api/admin/roles": (req) =>
        req.method === "POST" ? { ok: false, status: 409, json: { error: "already exists" } } : listing([]),
    });
    const { getByText, getByLabelText } = await renderLoaded();
    fireEvent.click(getByText("New role"));
    fireEvent.change(getByLabelText("Name"), { target: { value: "Dup" } });
    fireEvent.change(getByLabelText("Members (one per line)"), { target: { value: "admin" } });
    await act(async () => {
      fireEvent.click(getByText("Declare role"));
    });
    expect(mockToastError).toHaveBeenCalledWith("already exists");
  });

  test("deleting asks first, then sends the DELETE; a refusal is shown", async () => {
    let refuse = false;
    const fetchMock = mockGlobalFetch({
      "/api/admin/roles/oncall": () =>
        refuse ? { ok: false, status: 404, json: { error: "not found" } } : { ok: true, json: { deleted: "oncall" } },
      "/api/admin/roles": listing(),
    });
    const { getByLabelText, getByText, queryByText, getByRole } = await renderLoaded();
    fireEvent.click(getByLabelText("Delete On-call"));
    expect(getByText("Delete this role?")).not.toBeNull();
    fireEvent.click(getByText("Cancel", { selector: "button" }));
    await waitFor(() => {
      if (queryByText("Delete this role?")) throw new Error("still open");
    });
    expect(calls(fetchMock, "DELETE")).toHaveLength(0);
    fireEvent.click(getByLabelText("Delete On-call"));
    await act(async () => {
      fireEvent.click(getByRole("button", { name: "Delete role" }));
    });
    expect(calls(fetchMock, "DELETE")).toHaveLength(1);
    expect(mockToastSuccess).toHaveBeenCalledWith('Role "On-call" deleted');
    refuse = true;
    fireEvent.click(getByLabelText("Delete On-call"));
    await act(async () => {
      fireEvent.click(getByRole("button", { name: "Delete role" }));
    });
    expect(mockToastError).toHaveBeenCalledWith("not found");
    fireEvent.click(getByText("Refresh"));
  });

  test("the helpers: the id shape and the member list", () => {
    expect(slugifyRoleId("Équipe On-call (EU)")).toBe("equipe-on-call-eu");
    expect(parseMembers(" a ,b\n\n a ")).toEqual(["a", "b"]);
  });
});
