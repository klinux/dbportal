import { describe, test, expect, mock } from "bun:test";

/** The MCP route (docs/CONTEXT.md §4.30): the Bearer gate, a body that is not JSON, a notification's empty 202, and no event stream on GET. */
let identity: unknown = { token: { id: "t1" }, session: { role: "user", username: "svc:agent" } };
mock.module("@/lib/api/service-auth", () => ({
  guardServiceRoute: async () =>
    identity
      ? { identity }
      : { response: Response.json({ error: "A valid service token is required" }, { status: 401 }) },
}));
const { GET, POST } = await import("@/app/api/mcp/route");
const url = "http://localhost/api/mcp";
const post = (body: string) =>
  POST(new Request(url, { method: "POST", body, headers: { "Content-Type": "application/json" } }));

describe("/api/mcp", () => {
  test("answers a message whole, a notification with an empty 202, a non-JSON body with a parse error, and 401 without a token", async () => {
    const ping = await post(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }));
    expect(ping.status).toBe(200);
    expect(await ping.json()).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
    const init = await post(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "initialize" }));
    expect(((await init.json()) as { result: { serverInfo: { version: string } } }).result.serverInfo.version).toMatch(
      /^\d+\.\d+\.\d+/,
    );
    const note = await post(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
    expect(note.status).toBe(202);
    expect(await note.text()).toBe("");
    const bad = await post("{not json");
    expect(bad.status).toBe(200);
    expect(await bad.json()).toMatchObject({ error: { code: -32700 } });
    identity = null;
    expect((await post(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }))).status).toBe(401);
  });

  test("GET is a 405 that says why", async () => {
    const res = await GET();
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("POST");
    expect((await res.json()).error).toContain("no event stream");
  });
});
