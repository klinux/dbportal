import "../../setup-dom";
import { mockToastSuccess } from "../../helpers/mock-sonner";
import React from "react";
import { describe, test, expect, afterEach } from "bun:test";
import { render, waitFor, act, cleanup, fireEvent } from "@testing-library/react";
import { mockGlobalFetch, restoreGlobalFetch } from "../../helpers/mock-fetch";
import { SshIdentityDialog } from "@/components/admin/SshIdentityDialog";

/**
 * The administrator's own SSH identity dialog (docs/CONTEXT.md §4.9): what is stored is said
 * without the key, a save sends the user name and only a typed key or passphrase, a removal
 * asks the server and the dialog follows, and the server's refusal is shown in its words.
 */
const none = { ok: true, json: { identity: null } };
const set = { ok: true, json: { identity: { username: "ana_example_com", hasPrivateKey: true, hasPassphrase: false, updatedAt: "x" } } };

type Answer = Extract<Parameters<typeof mockGlobalFetch>[0][string], (req: Request) => unknown>;
async function renderOpen(answer: Answer) {
  const fetchMock = mockGlobalFetch({ "/api/me/ssh-identity": answer });
  const view = render(<SshIdentityDialog open onOpenChange={() => {}} />);
  await waitFor(() => {
    if (view.queryByTestId("ssh-identity-loading")) throw new Error("still loading");
  });
  return { view, fetchMock };
}
const calls = (fetchMock: ReturnType<typeof mockGlobalFetch>, method: string) =>
  fetchMock.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method === method);

describe("SshIdentityDialog", () => {
  afterEach(() => {
    cleanup();
    restoreGlobalFetch();
  });

  test("with none stored, says so, and saves the user name with a typed key", async () => {
    const { view, fetchMock } = await renderOpen((req) => (req.method === "PUT" ? set : none));
    expect(view.getByTestId("ssh-identity-state").textContent).toContain("No identity yet");
    expect(view.queryByText("Remove identity")).toBeNull();
    const save = view.getByText("Save identity").closest("button") as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(view.getByLabelText("SSH username"), { target: { value: "ana_example_com" } });
    expect(save.disabled).toBe(true);
    fireEvent.change(view.getByLabelText("Private key"), { target: { value: "-----BEGIN OPENSSH PRIVATE KEY-----\nk" } });
    expect(save.disabled).toBe(false);
    await act(async () => {
      fireEvent.click(save);
    });
    const [put] = calls(fetchMock, "PUT");
    expect(JSON.parse((put[1] as RequestInit).body as string)).toEqual({
      username: "ana_example_com",
      privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nk",
    });
    expect(mockToastSuccess).toHaveBeenCalledWith("SSH identity saved");
    expect(view.getByTestId("ssh-identity-state").textContent).toContain("A key is set for ana_example_com");
    expect((view.getByLabelText("Private key") as HTMLTextAreaElement).value).toBe("");
  });

  test("with one stored, a blank key keeps it, a passphrase travels only when typed, and removal follows the server", async () => {
    const { view, fetchMock } = await renderOpen((req) =>
      req.method === "DELETE" ? { ok: true, json: { ok: true, removed: true } } : set,
    );
    expect(view.getByTestId("ssh-identity-state").textContent).toContain("Leave the key blank to keep it");
    expect((view.getByLabelText("SSH username") as HTMLInputElement).value).toBe("ana_example_com");
    fireEvent.change(view.getByLabelText("Passphrase (optional)"), { target: { value: "pp" } });
    await act(async () => {
      fireEvent.click(view.getByText("Save identity"));
    });
    const [put] = calls(fetchMock, "PUT");
    expect(JSON.parse((put[1] as RequestInit).body as string)).toEqual({ username: "ana_example_com", passphrase: "pp" });
    await act(async () => {
      fireEvent.click(view.getByText("Remove identity"));
    });
    expect(calls(fetchMock, "DELETE")).toHaveLength(1);
    expect(mockToastSuccess).toHaveBeenCalledWith("SSH identity removed");
    expect(view.getByTestId("ssh-identity-state").textContent).toContain("No identity yet");
  });

  test("a removal the server refuses is shown, and the identity stays", async () => {
    const { view } = await renderOpen((req) =>
      req.method === "DELETE" ? { ok: false, status: 503, json: { error: "An SSH identity needs server storage" } } : set,
    );
    await act(async () => {
      fireEvent.click(view.getByText("Remove identity"));
    });
    expect(view.getByTestId("ssh-identity-error").textContent).toContain("needs server storage");
    expect(view.getByTestId("ssh-identity-state").textContent).toContain("A key is set");
  });

  test("the server's refusal is shown in its own words, on load and on save", async () => {
    const { view } = await renderOpen((req) =>
      req.method === "PUT"
        ? { ok: false, status: 400, json: { error: "Invalid SSH identity: the private key is not in PEM form" } }
        : { ok: false, status: 503, json: { error: "An SSH identity needs server storage" } },
    );
    expect(view.getByTestId("ssh-identity-error").textContent).toContain("needs server storage");
    fireEvent.change(view.getByLabelText("SSH username"), { target: { value: "ana" } });
    fireEvent.change(view.getByLabelText("Private key"), { target: { value: "not-pem" } });
    await act(async () => {
      fireEvent.click(view.getByText("Save identity"));
    });
    expect(view.getByTestId("ssh-identity-error").textContent).toContain("not in PEM form");
  });
});
