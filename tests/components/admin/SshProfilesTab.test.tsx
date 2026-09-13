import "../../setup-dom";
import { mockToastSuccess, mockToastError } from "../../helpers/mock-sonner";
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { render, fireEvent, cleanup, waitFor, act, within } from "@testing-library/react";
import { mockGlobalFetch, restoreGlobalFetch } from "../../helpers/mock-fetch";
import { SshProfilesTab, slugifyProfileId, toProfilePayload } from "@/components/admin/tabs/SshProfilesTab";

/**
 * The SSH profiles section of the datasources page (docs/CONTEXT.md §4.9): the list with
 * what each row may say about a secret (set, or which reference - never a value), the
 * sheet that creates and edits one without ever echoing a stored secret, and the delete
 * the server may refuse while a datasource names the profile.
 */
const stored = {
  id: "prod-bastion",
  name: "Production bastion",
  host: "bastion.internal",
  port: 22,
  username: "portal",
  authMethod: "privateKey",
  source: "store",
  hasPassword: false,
  hasPrivateKey: true,
  hasPassphrase: true,
  privateKeyRef: "${BASTION_KEY}",
  hostKeyFingerprint: "SHA256:abc",
  updatedAt: "2026-09-13T00:00:00.000Z",
  updatedBy: "root",
};
const declared = {
  id: "seed-bastion",
  name: "Seed bastion",
  host: "seed.internal",
  port: 2222,
  username: "ops",
  authMethod: "password",
  source: "config",
  hasPassword: true,
  hasPrivateKey: false,
  hasPassphrase: false,
};

const listing = (profiles: unknown[] = [stored, declared]) => ({ ok: true, json: { profiles } });

async function renderLoaded() {
  const result = render(<SshProfilesTab />);
  await waitFor(() => {
    if (result.queryByTestId("ssh-profiles-loading")) throw new Error("still loading");
  });
  return result;
}

const calls = (fetchMock: ReturnType<typeof mockGlobalFetch>, method: string) =>
  fetchMock.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method === method);

describe("SshProfilesTab", () => {
  beforeEach(() => {
    mockToastSuccess.mockClear();
    mockToastError.mockClear();
  });

  afterEach(() => {
    cleanup();
    restoreGlobalFetch();
  });

  test("lists every profile with its bastion, auth, reference and host-key state; a seed-file one has no edit or delete", async () => {
    mockGlobalFetch({ "/api/admin/ssh-profiles": listing() });
    const { getByTestId } = await renderLoaded();
    const prod = within(getByTestId("ssh-profile-prod-bastion"));
    expect(prod.getByText("portal@bastion.internal:22")).not.toBeNull();
    expect(prod.getByText("private key")).not.toBeNull();
    expect(prod.getByText("${BASTION_KEY}")).not.toBeNull();
    expect(prod.getByText("pinned")).not.toBeNull();
    expect(prod.getByLabelText("Edit Production bastion")).not.toBeNull();
    expect(prod.getByLabelText("Delete Production bastion")).not.toBeNull();

    const seed = within(getByTestId("ssh-profile-seed-bastion"));
    expect(seed.getByText("seed file")).not.toBeNull();
    expect(seed.getByText("trust on first use")).not.toBeNull();
    expect(seed.queryByLabelText("Edit Seed bastion")).toBeNull();
  });

  test("an empty store says where a profile is declared, and a failed read is shown in the server's words", async () => {
    mockGlobalFetch({ "/api/admin/ssh-profiles": listing([]) });
    const first = await renderLoaded();
    expect(first.getByTestId("ssh-profiles-empty").textContent).toContain("sshProfiles");
    cleanup();
    restoreGlobalFetch();

    mockGlobalFetch({ "/api/admin/ssh-profiles": { ok: false, status: 503, json: { error: "no store" } } });
    const { findByTestId } = render(<SshProfilesTab />);
    expect((await findByTestId("ssh-profiles-error")).textContent).toContain("no store");
  });

  test("creating posts the typed fields with an id derived from the name, a secret only when typed, then reloads", async () => {
    const fetchMock = mockGlobalFetch({
      "/api/admin/ssh-profiles": (req) =>
        req.method === "POST" ? { status: 201, ok: true, json: { profile: stored } } : listing([]),
    });
    const { getByText, getByLabelText, getByTestId } = await renderLoaded();
    fireEvent.click(getByText("New profile"));
    expect(getByTestId("ssh-profile-sheet")).not.toBeNull();
    expect(getByText(/sealed at rest/)).not.toBeNull();

    fireEvent.change(getByLabelText("Name"), { target: { value: "Prod Bastion (EU)" } });
    expect(getByText("id: prod-bastion-eu")).not.toBeNull();
    fireEvent.change(getByLabelText("Host"), { target: { value: " bastion.eu " } });
    fireEvent.change(getByLabelText("Port"), { target: { value: "2200" } });
    fireEvent.change(getByLabelText("Username"), { target: { value: "portal" } });
    fireEvent.change(getByLabelText("Private key"), { target: { value: "${BASTION_KEY}" } });
    fireEvent.change(getByLabelText("Host key fingerprint (optional, pins the bastion)"), {
      target: { value: "SHA256:x" },
    });
    await act(async () => {
      fireEvent.click(getByText("Create profile"));
    });

    const [post] = calls(fetchMock, "POST");
    expect(String(post[0])).toContain("/api/admin/ssh-profiles");
    expect(JSON.parse((post[1] as RequestInit).body as string)).toEqual({
      id: "prod-bastion-eu",
      name: "Prod Bastion (EU)",
      host: "bastion.eu",
      port: 2200,
      username: "portal",
      authMethod: "privateKey",
      privateKey: "${BASTION_KEY}",
      hostKeyFingerprint: "SHA256:x",
    });
    expect(mockToastSuccess).toHaveBeenCalledWith('SSH profile "Prod Bastion (EU)" created');
    // Reloaded after the save: the initial GET and one more.
    expect(fetchMock.mock.calls.filter((c) => !(c[1] as RequestInit | undefined)?.method).length).toBe(2);
  });

  test("a name without a slug, or a missing host, is refused before any request", async () => {
    const fetchMock = mockGlobalFetch({ "/api/admin/ssh-profiles": listing([]) });
    const { getByText, getByLabelText } = await renderLoaded();
    fireEvent.click(getByText("New profile"));
    fireEvent.change(getByLabelText("Name"), { target: { value: "***" } });
    fireEvent.click(getByText("Create profile"));
    expect(mockToastError).toHaveBeenCalledWith("Give the profile a name with at least one letter or digit.");
    fireEvent.change(getByLabelText("Name"), { target: { value: "Bastion" } });
    fireEvent.click(getByText("Create profile"));
    expect(mockToastError).toHaveBeenCalledWith("Host and username are required.");
    expect(calls(fetchMock, "POST")).toHaveLength(0);
  });

  test("editing opens the sheet without the secret, says the stored one is a reference, and PUTs to the profile's path", async () => {
    const fetchMock = mockGlobalFetch({
      "/api/admin/ssh-profiles/prod-bastion": { ok: true, json: { profile: stored } },
      "/api/admin/ssh-profiles": listing(),
    });
    const { getByLabelText, getByText } = await renderLoaded();
    fireEvent.click(getByLabelText("Edit Production bastion"));
    expect(getByText(/references \$\{BASTION_KEY\} on the server/)).not.toBeNull();
    expect((getByLabelText("Private key") as HTMLTextAreaElement).value).toBe("");
    expect((getByLabelText("Host") as HTMLInputElement).value).toBe("bastion.internal");
    fireEvent.change(getByLabelText("Host"), { target: { value: "bastion2.internal" } });
    await act(async () => {
      fireEvent.click(getByText("Save profile"));
    });
    const [put] = calls(fetchMock, "PUT");
    expect(String(put[0])).toContain("/api/admin/ssh-profiles/prod-bastion");
    const body = JSON.parse((put[1] as RequestInit).body as string);
    expect(body.host).toBe("bastion2.internal");
    expect(body.id).toBe("prod-bastion");
    // Blank in the sheet means "keep": the key is not sent, not sent empty.
    expect(body).not.toHaveProperty("privateKey");
    expect(mockToastSuccess).toHaveBeenCalledWith('SSH profile "Production bastion" updated');
  });

  test("the password method shows a password box and the editor explains a stored password without showing it", async () => {
    mockGlobalFetch({ "/api/admin/ssh-profiles": listing() });
    const { getByLabelText, getByText, queryByLabelText } = await renderLoaded();
    fireEvent.click(getByText("New profile"));
    fireEvent.change(getByLabelText("Authentication"), { target: { value: "password" } });
    expect(getByLabelText("Password")).not.toBeNull();
    expect(queryByLabelText("Private key")).toBeNull();
    fireEvent.change(getByLabelText("Password"), { target: { value: "pw" } });
    expect(
      toProfilePayload(
        {
          id: "",
          name: "n",
          host: "h",
          port: "x",
          username: "u",
          authMethod: "password",
          password: "pw",
          privateKey: "k",
          passphrase: "p",
          hostKeyFingerprint: "",
        },
        "n",
      ),
    ).toEqual({
      id: "n",
      name: "n",
      host: "h",
      port: 22,
      username: "u",
      authMethod: "password",
      password: "pw",
    });
  });

  test("the server's refusal of a save is shown in its words", async () => {
    mockGlobalFetch({
      "/api/admin/ssh-profiles": (req) =>
        req.method === "POST" ? { ok: false, status: 409, json: { error: "already exists" } } : listing([]),
    });
    const { getByText, getByLabelText } = await renderLoaded();
    fireEvent.click(getByText("New profile"));
    fireEvent.change(getByLabelText("Name"), { target: { value: "Bastion" } });
    fireEvent.change(getByLabelText("Host"), { target: { value: "h" } });
    fireEvent.change(getByLabelText("Username"), { target: { value: "u" } });
    await act(async () => {
      fireEvent.click(getByText("Create profile"));
    });
    expect(mockToastError).toHaveBeenCalledWith("already exists");
  });

  test("deleting asks first, then sends the DELETE; a refusal while a datasource names the profile is shown", async () => {
    let refuse = false;
    const fetchMock = mockGlobalFetch({
      "/api/admin/ssh-profiles/prod-bastion": () =>
        refuse ? { ok: false, status: 409, json: { error: "used by orders" } } : { ok: true, json: { deleted: "x" } },
      "/api/admin/ssh-profiles": listing(),
    });
    const { getByLabelText, getByText, queryByText } = await renderLoaded();
    fireEvent.click(getByLabelText("Delete Production bastion"));
    expect(getByText("Delete SSH profile?")).not.toBeNull();
    fireEvent.click(getByText("Cancel", { selector: "button" }));
    await waitFor(() => {
      if (queryByText("Delete SSH profile?")) throw new Error("still open");
    });
    expect(calls(fetchMock, "DELETE")).toHaveLength(0);

    fireEvent.click(getByLabelText("Delete Production bastion"));
    await act(async () => {
      fireEvent.click(getByText("Delete", { selector: "button" }));
    });
    expect(calls(fetchMock, "DELETE")).toHaveLength(1);
    expect(mockToastSuccess).toHaveBeenCalledWith('SSH profile "Production bastion" deleted');

    refuse = true;
    fireEvent.click(getByLabelText("Delete Production bastion"));
    await act(async () => {
      fireEvent.click(getByText("Delete", { selector: "button" }));
    });
    expect(mockToastError).toHaveBeenCalledWith("used by orders");
  });

  test("slugifyProfileId produces the schema's id shape", () => {
    expect(slugifyProfileId("Bastion (Produção) #1")).toBe("bastion-producao-1");
    expect(slugifyProfileId("***")).toBe("");
    expect(slugifyProfileId("x".repeat(80))).toHaveLength(64);
  });
});
