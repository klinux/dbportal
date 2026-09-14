import { describe, test, expect, mock, beforeEach } from "bun:test";

/**
 * Notification channels (docs/CONTEXT.md §4.29): the seed file's and the store's listed
 * with their source, a declaration validated - a Slack channel id, or an https URL bare of
 * credentials for the three webhook kinds - refused under an id already taken, and deleted
 * only when stored and not named by an alert.
 */
let serverStorage = true;
let rows: unknown[] | null = [];
const provider = {
  getCollection: mock(async () => rows),
  setCollection: mock(async (_o: string, _c: string, value: unknown[]) => {
    rows = value;
  }),
};
mock.module("@/lib/storage/factory", () => ({
  isServerStorageEnabled: () => serverStorage,
  getStorageProvider: async () => (serverStorage ? provider : null),
}));
let declared: unknown[] = [];
mock.module("@/lib/seed/config-loader", () => ({
  loadConfig: async () => ({ version: "1", connections: [], channels: declared }),
}));

const {
  ChannelError,
  deleteChannel,
  findChannel,
  listChannels,
  mayManageChannel,
  resetChannelsCache,
  saveChannel,
  summarize,
} = await import("@/lib/channels/store");
const root = { username: "root", admin: true };
const ana = { username: "ana", admin: false };
const bob = { username: "bob", admin: false };
const savedHosts = process.env.CALLBACK_ALLOWED_HOSTS;

const status = async (p: Promise<unknown>) => {
  try {
    await p;
    return 200;
  } catch (e) {
    return e instanceof ChannelError ? e.statusCode : -1;
  }
};
const never = async () => false;
const slack = { id: "ops-slack", name: "Ops", kind: "slack", target: "C0123" };

describe("channels store", () => {
  beforeEach(() => {
    resetChannelsCache();
    serverStorage = true;
    rows = [];
    declared = [];
    provider.setCollection.mockClear();
    if (savedHosts === undefined) delete process.env.CALLBACK_ALLOWED_HOSTS;
    else process.env.CALLBACK_ALLOWED_HOSTS = savedHosts;
  });

  test("lists the seed file's first, then the store's; a summary carries no target", async () => {
    declared = [{ id: "pager", name: "Pager", kind: "rootly", target: "https://rootly.example.test/hook" }];
    await saveChannel(slack, root);
    expect((await listChannels()).map((e) => [e.channel.id, e.source])).toEqual([
      ["pager", "config"],
      ["ops-slack", "store"],
    ]);
    expect((provider.setCollection.mock.calls[0] as unknown[]).slice(0, 2)).toEqual([
      "shared:channels",
      "notification_channels",
    ]);
    expect(await findChannel("ops-slack")).toMatchObject({ ...slack, createdBy: "root" });
    expect(await findChannel("ghost")).toBeNull();
    expect(summarize((await findChannel("pager"))!)).toEqual({ id: "pager", name: "Pager", kind: "rootly" });
    expect(summarize((await findChannel("ops-slack"))!)).toEqual({
      id: "ops-slack",
      name: "Ops",
      kind: "slack",
      createdBy: "root",
    });
    // Without server storage there is only the seed file.
    serverStorage = false;
    resetChannelsCache();
    expect((await listChannels()).map((e) => e.channel.id)).toEqual(["pager"]);
  });

  test("a declaration is validated: the shape, https without credentials for a webhook, and an id not yet taken", async () => {
    expect(await status(saveChannel({ id: "x", name: "", kind: "slack", target: "C1" }, root))).toBe(400);
    expect(await status(saveChannel({ id: "x", name: "X", kind: "pigeon", target: "C1" }, root))).toBe(400);
    expect(await status(saveChannel({ id: "x", name: "X", kind: "webhook", target: "not a url" }, root))).toBe(400);
    expect(await status(saveChannel({ id: "x", name: "X", kind: "webhook", target: "http://h.test/x" }, root))).toBe(
      400,
    );
    expect(
      await status(saveChannel({ id: "x", name: "X", kind: "oncall", target: "https://u:p@h.test/x" }, root)),
    ).toBe(400);
    expect(await status(saveChannel({ id: "x", name: "X", kind: "oncall", target: "https://h.test/x" }, root))).toBe(
      200,
    );
    expect(await status(saveChannel({ id: "x", name: "X", kind: "oncall", target: "https://h.test/x" }, root))).toBe(
      409,
    );
    // A person's webhook host must be one an administrator allowed; a Slack channel needs no list.
    expect(await status(saveChannel({ id: "y", name: "Y", kind: "webhook", target: "https://h.test/y" }, ana))).toBe(
      403,
    );
    process.env.CALLBACK_ALLOWED_HOSTS = "hooks.example.test, H.TEST";
    expect(await status(saveChannel({ id: "y", name: "Y", kind: "webhook", target: "https://h.test/y" }, ana))).toBe(
      200,
    );
    expect(await status(saveChannel({ id: "z", name: "Z", kind: "rootly", target: "https://other.test/z" }, ana))).toBe(
      403,
    );
    expect(await status(saveChannel({ id: "s", name: "S", kind: "slack", target: "C9" }, ana))).toBe(200);
    declared = [{ id: "pager", name: "Pager", kind: "rootly", target: "https://r.test/h" }];
    resetChannelsCache();
    expect(await status(saveChannel({ ...slack, id: "pager" }, root))).toBe(409);
    // A store that is not there is a 503, not a crash.
    serverStorage = false;
    resetChannelsCache();
    expect(await status(saveChannel(slack, root))).toBe(503);
  });

  test("deletes a stored one that no alert names, by whoever declared it or an administrator; a seed-file one is not found, one in use is refused", async () => {
    declared = [{ id: "pager", name: "Pager", kind: "rootly", target: "https://r.test/h" }];
    await saveChannel(slack, root);
    await saveChannel({ id: "anas", name: "Ana's", kind: "slack", target: "C2" }, ana);
    expect(mayManageChannel((await findChannel("pager"))!, ana)).toBe(false);
    expect(mayManageChannel((await findChannel("pager"))!, root)).toBe(true);
    expect(mayManageChannel((await findChannel("anas"))!, ana)).toBe(true);
    expect(mayManageChannel((await findChannel("anas"))!, bob)).toBe(false);
    expect(await status(deleteChannel("pager", never, root))).toBe(404);
    expect(await status(deleteChannel("ops-slack", async () => true, root))).toBe(409);
    expect(await status(deleteChannel("ops-slack", never, ana))).toBe(403);
    expect(await status(deleteChannel("anas", never, bob))).toBe(403);
    expect((await deleteChannel("anas", never, ana)).id).toBe("anas");
    expect((await deleteChannel("ops-slack", never, root)).id).toBe("ops-slack");
    expect(await findChannel("ops-slack")).toBeNull();
  });
});
