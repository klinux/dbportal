import "../../setup-dom";
import { mockToastSuccess, mockToastError } from "../../helpers/mock-sonner";
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { render, fireEvent, cleanup, act, waitFor } from "@testing-library/react";
import { mockGlobalFetch, restoreGlobalFetch } from "../../helpers/mock-fetch";
import { POLL_MS, SeedDataPanel } from "@/components/admin/SeedDataPanel";

/**
 * The seed panel (docs/CONTEXT.md §4.23): the schema read into an editable plan, the
 * confirmation, the run started with the counts and the truncate choice, its progress
 * polled until it ends, and the server's refusals in its words.
 */
const plan = {
  schema: "public",
  tables: [
    { name: "customers", columns: 4, dependsOn: [], rows: 100 },
    { name: "orders", columns: 6, dependsOn: ["customers"], rows: 100 },
  ],
};
const running = {
  id: "run-1",
  datasourceId: "stage",
  datasourceName: "Stage",
  schema: "public",
  truncated: false,
  status: "running",
  startedBy: "root",
  startedAt: "2026-09-14T00:00:00.000Z",
  tables: [
    { name: "customers", target: 100, inserted: 100 },
    { name: "orders", target: 300, inserted: 120 },
  ],
};
const calls = (fetchMock: ReturnType<typeof mockGlobalFetch>, method: string) =>
  fetchMock.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method === method);

describe("SeedDataPanel", () => {
  beforeEach(() => {
    mockToastSuccess.mockClear();
    mockToastError.mockClear();
  });
  afterEach(() => {
    cleanup();
    restoreGlobalFetch();
  });

  test("reads the schema into a plan with editable counts, and shows a refusal in the server's words", async () => {
    const fetchMock = mockGlobalFetch({ "/api/admin/seed-data/plan": { ok: true, json: plan } });
    const { getByText, findByTestId, getByLabelText } = render(
      <SeedDataPanel datasourceId="stage" datasourceName="Stage" />,
    );
    fireEvent.change(getByLabelText("Schema"), { target: { value: "sales" } });
    await act(async () => {
      fireEvent.click(getByText("Read schema"));
    });
    expect(JSON.parse((calls(fetchMock, "POST")[0][1] as RequestInit).body as string)).toEqual({
      datasourceId: "stage",
      schema: "sales",
    });
    expect(await findByTestId("seed-table-orders")).not.toBeNull();
    expect((getByLabelText("Rows for orders") as HTMLInputElement).value).toBe("100");
    expect(getByText("Seed 200 rows")).not.toBeNull();
    fireEvent.change(getByLabelText("Rows for orders"), { target: { value: "300" } });
    expect(getByText("Seed 400 rows")).not.toBeNull();
    cleanup();
    restoreGlobalFetch();
    mockGlobalFetch({
      "/api/admin/seed-data/plan": {
        ok: false,
        status: 403,
        json: { error: "A production datasource is never seeded" },
      },
    });
    const refused = render(<SeedDataPanel datasourceId="prod" datasourceName="Prod" />);
    await act(async () => {
      fireEvent.click(refused.getByText("Read schema"));
    });
    expect((await refused.findByTestId("seed-data-error")).textContent).toContain("never seeded");
  });

  test("seeding asks first, posts the counts and the truncate choice, then polls the run to its end", async () => {
    let polls = 0;
    // One key for the run route: the poll URL contains it, so the handler tells the two apart by method.
    const fetchMock = mockGlobalFetch({
      "/api/admin/seed-data/plan": { ok: true, json: plan },
      "/api/admin/seed-data/run": (req) => {
        // The route answers the queued run first (§4.40); the worker's snapshot follows on the next poll.
        if (req.method === "POST") return { ok: true, status: 202, json: { run: { ...running, status: "queued" } } };
        polls += 1;
        return polls < 2
          ? { ok: true, json: { run: running } }
          : {
              ok: true,
              json: {
                run: {
                  ...running,
                  status: "done",
                  tables: [running.tables[0], { name: "orders", target: 300, inserted: 300 }],
                },
              },
            };
      },
    });
    const view = render(<SeedDataPanel datasourceId="stage" datasourceName="Stage" />);
    await act(async () => {
      fireEvent.click(view.getByText("Read schema"));
    });
    await view.findByTestId("seed-table-orders");
    fireEvent.change(view.getByLabelText("Rows for orders"), { target: { value: "300" } });
    fireEvent.click(view.getByLabelText("Empty the tables first"));
    fireEvent.click(view.getByText("Seed 400 rows"));
    expect(view.getByText("Seed Stage?")).not.toBeNull();
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Seed" }));
    });
    const started = calls(fetchMock, "POST").find((c) => String(c[0]).endsWith("/api/admin/seed-data/run"))!;
    expect(JSON.parse((started[1] as RequestInit).body as string)).toEqual({
      datasourceId: "stage",
      schema: "public",
      counts: { customers: 100, orders: 300 },
      ratios: {},
      mode: "generate",
      truncate: true,
    });
    expect(view.getByTestId("seed-status").textContent).toBe("queued");
    expect((view.getByLabelText("Rows for orders") as HTMLInputElement).disabled).toBe(true);
    await act(async () => {
      fireEvent.click(view.getByText("Refresh"));
    });
    expect(view.getByTestId("seed-status").textContent).toBe("running");
    // The panel polls again on its own after POLL_MS; the second answer is the end.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, POLL_MS + 200));
    });
    expect(view.getByTestId("seed-status").textContent).toBe("done");
    expect(view.getByTestId("seed-table-orders").textContent).toContain("300 / 300");
    expect(mockToastSuccess).toHaveBeenCalledWith("Seed done on Stage");
  });

  test("a failed table shows its failure, and a refused start shows the server's words", async () => {
    mockGlobalFetch({
      "/api/admin/seed-data/plan": { ok: true, json: plan },
      "/api/admin/seed-data/run": () => ({
        ok: true,
        status: 202,
        json: {
          run: {
            ...running,
            status: "failed",
            tables: [{ name: "customers", target: 100, inserted: 0, error: "duplicate key" }, running.tables[1]],
          },
        },
      }),
    });
    const view = render(<SeedDataPanel datasourceId="stage" datasourceName="Stage" />);
    await act(async () => {
      fireEvent.click(view.getByText("Read schema"));
    });
    await view.findByTestId("seed-table-orders");
    fireEvent.click(view.getByText("Seed 200 rows"));
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Seed" }));
    });
    expect(view.getByTestId("seed-error-customers").textContent).toContain("failed");
    expect(view.getByTestId("seed-status").textContent).toBe("failed");
    cleanup();
    restoreGlobalFetch();
    mockGlobalFetch({
      "/api/admin/seed-data/plan": { ok: true, json: plan },
      "/api/admin/seed-data/run": () => ({ ok: false, status: 409, json: { error: "A seed is already running" } }),
    });
    const again = render(<SeedDataPanel datasourceId="stage" datasourceName="Stage" />);
    await act(async () => {
      fireEvent.click(again.getByText("Read schema"));
    });
    await again.findByTestId("seed-table-orders");
    fireEvent.click(again.getByText("Seed 200 rows"));
    await act(async () => {
      fireEvent.click(again.getByRole("button", { name: "Seed" }));
    });
    expect((await again.findByTestId("seed-data-error")).textContent).toContain("already running");
  });

  // docs/CONTEXT.md §4.23 on MySQL: the panel starts from the datasource's database, says so, and offers MySQL sources only.
  test("a MySQL target starts from its database and offers a sample from MySQL datasources only", async () => {
    const fetchMock = mockGlobalFetch({
      "/api/connections/managed": {
        ok: true,
        json: {
          connections: [
            { id: "seed:prod", seedId: "prod", name: "Prod", type: "postgres", createdAt: "2026-09-14T00:00:00.000Z" },
            { id: "seed:my", seedId: "my", name: "My", type: "mysql", createdAt: "2026-09-14T00:00:00.000Z" },
            { id: "seed:smb", seedId: "smb", name: "smb", type: "mysql", createdAt: "2026-09-14T00:00:00.000Z" },
          ],
        },
      },
      "/api/admin/seed-data/plan": { ok: true, json: plan },
    });
    const view = render(<SeedDataPanel datasourceId="smb" datasourceName="smb" engine="mysql" defaultSchema="smb" />);
    expect((view.getByLabelText("Database") as HTMLInputElement).value).toBe("smb");
    await act(async () => {
      fireEvent.click(view.getByText("Read schema"));
    });
    await view.findByTestId("seed-table-orders");
    const planCall = fetchMock.mock.calls.find((c) => String(c[0]).includes("/seed-data/plan"))!;
    expect(JSON.parse((planCall[1] as RequestInit).body as string)).toEqual({ datasourceId: "smb", schema: "smb" });
    fireEvent.change(view.getByLabelText("Rows"), { target: { value: "copy" } });
    await waitFor(() => {
      if (!(view.getByLabelText("From") as HTMLSelectElement).querySelector('option[value="my"]'))
        throw new Error("sources not yet");
    });
    const options = [...(view.getByLabelText("From") as HTMLSelectElement).options].map((o) => o.textContent);
    expect(options).toEqual(["Select a MySQL datasource", "My"]);
  });

  // docs/CONTEXT.md §4.31: the copy mode names a source among the other PostgreSQL datasources; a child may take rows per parent.
  test("copy mode posts the source and the ratios; a source must be picked first; a ratio replaces the count in the total", async () => {
    const fetchMock = mockGlobalFetch({
      "/api/connections/managed": {
        ok: true,
        json: {
          connections: [
            {
              id: "seed:stage",
              seedId: "stage",
              name: "Stage",
              type: "postgres",
              createdAt: "2026-09-14T00:00:00.000Z",
            },
            { id: "seed:prod", seedId: "prod", name: "Prod", type: "postgres", createdAt: "2026-09-14T00:00:00.000Z" },
            { id: "seed:my", seedId: "my", name: "My", type: "mysql", createdAt: "2026-09-14T00:00:00.000Z" },
          ],
        },
      },
      "/api/admin/seed-data/plan": { ok: true, json: plan },
      "/api/admin/seed-data/run": (req) =>
        req.method === "POST"
          ? { ok: true, status: 202, json: { run: { ...running, mode: "copy", sourceName: "Prod" } } }
          : { ok: true, json: { run: { ...running, status: "done" } } },
    });
    const view = render(<SeedDataPanel datasourceId="stage" datasourceName="Stage" />);
    await act(async () => {
      fireEvent.click(view.getByText("Read schema"));
    });
    await view.findByTestId("seed-table-orders");
    fireEvent.change(view.getByLabelText("Rows"), { target: { value: "copy" } });
    await waitFor(() => {
      if (!(view.getByLabelText("From") as HTMLSelectElement).querySelector('option[value="prod"]'))
        throw new Error("sources not yet");
    });
    // Only other PostgreSQL datasources are offered: not the target itself, not the MySQL one.
    const options = [...(view.getByLabelText("From") as HTMLSelectElement).options].map((o) => o.value);
    expect(options).toEqual(["", "prod"]);
    // Orders takes 5 rows per customer: its own count stops counting.
    fireEvent.change(view.getByLabelText("Rows per parent for orders"), { target: { value: "5" } });
    expect((view.getByLabelText("Rows for orders") as HTMLInputElement).disabled).toBe(true);
    expect(view.getByText("Copy 100 rows + 1 by ratio")).not.toBeNull();
    // Customers has no parent, so no ratio box.
    expect(view.queryByLabelText("Rows per parent for customers")).toBeNull();
    fireEvent.click(view.getByText("Copy 100 rows + 1 by ratio"));
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Seed" }));
    });
    expect(view.getByTestId("seed-data-error").textContent).toBe("Pick the datasource the sample comes from.");
    fireEvent.change(view.getByLabelText("From"), { target: { value: "prod" } });
    fireEvent.click(view.getByText("Copy 100 rows + 1 by ratio"));
    expect(view.getByText(/A masked sample of Prod/)).not.toBeNull();
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Seed" }));
    });
    const started = calls(fetchMock, "POST").find((c) => String(c[0]).endsWith("/api/admin/seed-data/run"))!;
    expect(JSON.parse((started[1] as RequestInit).body as string)).toEqual({
      datasourceId: "stage",
      schema: "public",
      counts: { customers: 100, orders: 100 },
      ratios: { orders: 5 },
      mode: "copy",
      sourceDatasourceId: "prod",
      truncate: false,
    });
  });
});
