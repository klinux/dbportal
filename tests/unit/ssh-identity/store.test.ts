import { describe, it, expect, beforeEach, mock } from "bun:test";

/**
 * A person's own SSH identity (docs/CONTEXT.md §4.9) in the server store: validated, a key
 * required once and kept across an edit that leaves it blank, a passphrase belonging to the
 * key it was typed with, removable, and never leaving as a value.
 */
let enabled = true;
let rows: Record<string, unknown> = {};
const provider = {
  getCollection: mock(async (owner: string, collection: string) => rows[`${owner}/${collection}`] ?? null),
  setCollection: mock(async (owner: string, collection: string, data: unknown) => {
    rows[`${owner}/${collection}`] = data;
  }),
};
mock.module("@/lib/storage/factory", () => ({
  isServerStorageEnabled: () => enabled,
  getStorageProvider: async () => (enabled ? provider : null),
}));
const { SshIdentityError, deleteSshIdentity, getSshIdentity, putSshIdentity, toSshIdentityView } = await import(
  "@/lib/ssh-identity/store"
);
const KEY = "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----";

async function status(promise: Promise<unknown>): Promise<number> {
  try {
    await promise;
    return 200;
  } catch (err) {
    expect(err).toBeInstanceOf(SshIdentityError);
    return (err as InstanceType<typeof SshIdentityError>).statusCode;
  }
}

describe("ssh identity store", () => {
  beforeEach(() => {
    enabled = true;
    rows = {};
  });

  it("without server storage: nothing to read, and a save is a 503", async () => {
    enabled = false;
    expect(await getSshIdentity("ana")).toBeNull();
    expect(await status(putSshIdentity("ana", { username: "ana", privateKey: KEY }))).toBe(503);
    expect(await status(deleteSshIdentity("ana"))).toBe(503);
  });

  it("saves under the person's own owner, keeps the key across a blank edit, and the view never carries it", async () => {
    const saved = await putSshIdentity("ana@example.test", { username: " ana_example_com ", privateKey: KEY, passphrase: "p" });
    expect(saved).toMatchObject({ username: "ana_example_com", privateKey: KEY, passphrase: "p" });
    expect(provider.setCollection.mock.calls[0].slice(0, 2)).toEqual(["ana@example.test", "ssh_identity"]);
    expect(toSshIdentityView(saved)).toEqual({
      username: "ana_example_com",
      hasPrivateKey: true,
      hasPassphrase: true,
      updatedAt: saved.updatedAt,
    });
    // A new user name with the key left blank keeps the key and its passphrase.
    const renamed = await putSshIdentity("ana@example.test", { username: "ana2", privateKey: "" });
    expect(renamed).toMatchObject({ username: "ana2", privateKey: KEY, passphrase: "p" });
    // A new key with no passphrase typed has none: the old passphrase belonged to the old key.
    const rekeyed = await putSshIdentity("ana@example.test", { username: "ana2", privateKey: KEY.replace("abc", "def") });
    expect(rekeyed.passphrase).toBeUndefined();
    expect((await getSshIdentity("ana@example.test"))?.privateKey).toContain("def");
    expect(await getSshIdentity("bob@example.test")).toBeNull();
  });

  it("refuses a bad user name, a first save without a key, and a key that is not PEM", async () => {
    expect(await status(putSshIdentity("ana", { username: "not a user", privateKey: KEY }))).toBe(400);
    expect(await status(putSshIdentity("ana", { username: "ana" }))).toBe(400);
    expect(await status(putSshIdentity("ana", { username: "ana", privateKey: "ssh-rsa AAAA public-key" }))).toBe(400);
    expect(await status(putSshIdentity("ana", "nonsense"))).toBe(400);
  });

  it("removes an identity, and says when there was none", async () => {
    expect(await deleteSshIdentity("ana")).toBe(false);
    await putSshIdentity("ana", { username: "ana", privateKey: KEY });
    expect(await deleteSshIdentity("ana")).toBe(true);
    expect(await getSshIdentity("ana")).toBeNull();
  });
});
