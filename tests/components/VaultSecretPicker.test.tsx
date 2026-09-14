import "../setup-dom";
import { describe, test, expect, mock, afterEach } from "bun:test";
import { render, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { mockGlobalFetch, restoreGlobalFetch } from "../helpers/mock-fetch";
import { VaultSecretPicker } from "@/components/VaultSecretPicker";

/**
 * The Vault button on the datasource sheet (docs/CONTEXT.md §4.39): opening it lists the
 * mount's root, a folder descends and the arrow goes back up, a secret hands its shaped
 * fields to the sheet, and what the server refuses is said in the popover.
 */
const root = { mount: "secret", path: "", folders: ["db"], secrets: [] };
const db = { mount: "secret", path: "db", folders: [], secrets: ["orders", "empty", "denied"] };
const shaped = {
  path: "db/orders",
  keys: ["host", "password"],
  fields: { host: "db.internal" },
  references: { password: "vault:kv:secret/db/orders#password" },
};
const until = async (check: () => boolean) => {
  await waitFor(() => {
    if (!check()) throw new Error("not yet");
  });
};

describe("VaultSecretPicker", () => {
  afterEach(() => {
    cleanup();
    restoreGlobalFetch();
  });

  test("browses folders, goes back up, and hands a picked secret to the sheet", async () => {
    mockGlobalFetch({
      "/api/admin/vault/kv": (req) => {
        const url = new URL(req.url);
        const secret = url.searchParams.get("secret");
        if (secret === "db/orders") return { json: shaped };
        if (secret === "db/denied") return { status: 502, text: "bad gateway" };
        if (secret === "db/empty")
          return { json: { ...shaped, path: "db/empty", keys: ["note"], fields: {}, references: {} } };
        return { json: url.searchParams.get("path") === "db" ? db : root };
      },
    });
    const onPick = mock((_f: unknown) => {});
    const view = render(<VaultSecretPicker onPick={onPick} />);
    fireEvent.click(view.getByTestId("vault-picker-open"));
    await until(() => view.queryByTestId("vault-folder-db") !== null);
    expect(view.getByTestId("vault-picker-path").textContent).toBe("secret/");
    expect((view.getByTestId("vault-picker-up") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(view.getByTestId("vault-folder-db"));
    await until(() => view.queryByTestId("vault-secret-orders") !== null);
    expect(view.getByTestId("vault-picker-path").textContent).toBe("secret/db");
    // A secret none of whose keys the sheet understands is said, not silently picked.
    fireEvent.click(view.getByTestId("vault-secret-empty"));
    await until(() => view.queryByTestId("vault-picker-error") !== null);
    expect(view.getByTestId("vault-picker-error").textContent).toContain("keys: note");
    expect(onPick).not.toHaveBeenCalled();
    // A read the server refuses is said the same way.
    fireEvent.click(view.getByTestId("vault-secret-denied"));
    await until(() => view.queryByTestId("vault-picker-error")?.textContent === "Vault answered 502");
    fireEvent.click(view.getByTestId("vault-picker-up"));
    await until(() => view.queryByTestId("vault-folder-db") !== null);
    fireEvent.click(view.getByTestId("vault-folder-db"));
    await until(() => view.queryByTestId("vault-secret-orders") !== null);
    fireEvent.click(view.getByTestId("vault-secret-orders"));
    await until(() => onPick.mock.calls.length === 1);
    expect(onPick).toHaveBeenLastCalledWith(shaped);
    // Picking closes the popover.
    await until(() => view.queryByTestId("vault-picker") === null);
  });

  test("says what the server refused, and when it could not be reached at all", async () => {
    mockGlobalFetch({
      "/api/admin/vault/kv": { status: 503, json: { error: "Vault is not configured on the server" } },
    });
    const view = render(<VaultSecretPicker onPick={() => {}} />);
    fireEvent.click(view.getByTestId("vault-picker-open"));
    await until(() => view.queryByTestId("vault-picker-error") !== null);
    expect(view.getByTestId("vault-picker-error").textContent).toContain("not configured");
    cleanup();

    // A refusal without a JSON body still names the status; an empty folder says so.
    mockGlobalFetch({ "/api/admin/vault/kv": { status: 502, text: "bad gateway" } });
    const second = render(<VaultSecretPicker onPick={() => {}} />);
    fireEvent.click(second.getByTestId("vault-picker-open"));
    await until(() => second.queryByTestId("vault-picker-error") !== null);
    expect(second.getByTestId("vault-picker-error").textContent).toBe("Vault answered 502");
    cleanup();

    mockGlobalFetch({ "/api/admin/vault/kv": { json: { mount: "secret", path: "", folders: [], secrets: [] } } });
    const third = render(<VaultSecretPicker onPick={() => {}} />);
    fireEvent.click(third.getByTestId("vault-picker-open"));
    await until(() => third.queryByText("Nothing here.") !== null);
    cleanup();

    globalThis.fetch = (async () => {
      throw new TypeError("network");
    }) as unknown as typeof fetch;
    const fourth = render(<VaultSecretPicker onPick={() => {}} />);
    fireEvent.click(fourth.getByTestId("vault-picker-open"));
    await until(() => fourth.queryByTestId("vault-picker-error") !== null);
    expect(fourth.getByTestId("vault-picker-error").textContent).toBe("Vault could not be reached");
    cleanup();

    // The listing answered, the secret's read did not.
    const listed = mockGlobalFetch({
      "/api/admin/vault/kv": { json: { mount: "secret", path: "", folders: [], secrets: ["s"] } },
    });
    const fifth = render(<VaultSecretPicker onPick={() => {}} />);
    fireEvent.click(fifth.getByTestId("vault-picker-open"));
    await until(() => fifth.queryByTestId("vault-secret-s") !== null);
    listed.mockImplementationOnce(async () => {
      throw new TypeError("network");
    });
    fireEvent.click(fifth.getByTestId("vault-secret-s"));
    await until(() => fifth.queryByTestId("vault-picker-error") !== null);
    expect(fifth.getByTestId("vault-picker-error").textContent).toBe("Vault could not be reached");
  });
});
