/**
 * The account sheet (docs/CONTEXT.md §4.54): the schemas listed on open with `public`
 * ticked, the plan shown before anything runs, the bootstrap credential sent with each
 * call and cleared on completion, the report and the seed-file references after a run.
 */
import "../../setup-dom";
import { mockToastError, mockToastSuccess } from "../../helpers/mock-sonner";
import React from "react";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { mockGlobalFetch, restoreGlobalFetch } from "../../helpers/mock-fetch";
import { ProvisionAccountSheet } from "@/components/admin/ProvisionAccountSheet";

const datasource = { id: "shop", name: "Shop", type: "postgres" };
const inventory = {
  bootstrapUser: "app",
  database: "shop",
  canCreateRole: true,
  serverVersion: 160000,
  availableSchemas: ["public", "sales"],
  roleExists: false,
  agentRoleExists: false,
  owners: [],
};
const plan = {
  roleName: "dbportal_shop",
  agentRoleName: "dbportal_shop_agent",
  statements: [
    {
      sql: "CREATE ROLE dbportal_shop LOGIN PASSWORD 'x'",
      shown: "CREATE ROLE dbportal_shop LOGIN PASSWORD '********'",
      purpose: "The role",
      account: "portal",
    },
    {
      sql: "GRANT pg_monitor TO dbportal_shop",
      shown: "GRANT pg_monitor TO dbportal_shop",
      purpose: "Monitoring",
      optional: true,
      account: "portal",
    },
  ],
  blockers: [] as string[],
};
const vault = { kind: "vault", mount: "dbportal", path: "datasources/shop" };

type Route = Parameters<typeof mockGlobalFetch>[0];
const bodies: Record<string, unknown>[] = [];
const paths: string[] = [];
function routes(
  answers: { plan?: (body: Record<string, unknown>) => unknown; run?: (body: Record<string, unknown>) => unknown } = {},
): Route {
  return {
    "/api/admin/datasources/shop/account/plan": async (req) => {
      const body = (await req.json()) as Record<string, unknown>;
      bodies.push(body);
      paths.push("plan");
      const answer = answers.plan ? answers.plan(body) : { inventory, plan, destination: vault };
      return answer && typeof answer === "object" && "status" in answer
        ? (answer as { status: number; json: unknown })
        : { ok: true, json: answer };
    },
    "/api/admin/datasources/shop/account": async (req) => {
      const body = (await req.json()) as Record<string, unknown>;
      bodies.push(body);
      paths.push("run");
      const answer = answers.run
        ? answers.run(body)
        : {
            roleName: "dbportal_shop",
            agentRoleName: null,
            statements: plan.statements.map((s) => ({ ...s, outcome: "ran" })),
            completed: true,
            destination: vault,
          };
      return answer && typeof answer === "object" && "status" in answer
        ? (answer as { status: number; json: unknown })
        : { ok: true, json: answer };
    },
  };
}

async function renderOpen(answers?: Parameters<typeof routes>[0], onProvisioned?: () => void) {
  mockGlobalFetch(routes(answers));
  const onOpenChange = (() => {}) as (open: boolean) => void;
  const view = render(
    <ProvisionAccountSheet open onOpenChange={onOpenChange} datasource={datasource} onProvisioned={onProvisioned} />,
  );
  await waitFor(() => {
    if (!view.queryByTestId("provision-schemas") && !view.queryByTestId("provision-error"))
      throw new Error("still reading");
  });
  return view;
}

const button = (view: ReturnType<typeof render>, label: string) =>
  view.getByRole("button", { name: label }) as HTMLButtonElement;

describe("ProvisionAccountSheet", () => {
  beforeEach(() => {
    bodies.length = 0;
    paths.length = 0;
    mockToastSuccess.mockClear();
    mockToastError.mockClear();
  });
  afterEach(() => {
    cleanup();
    restoreGlobalFetch();
  });

  // Opening reads the schemas with no schema picked, so the read is a pure inventory, and
  // ticks `public`: the schema every PostgreSQL database has and the usual starting point.
  test("lists the database's schemas on open, with public ticked, and nothing else run", async () => {
    const view = await renderOpen();

    expect(paths).toEqual(["plan"]);
    expect(bodies[0]).toEqual({ profile: "read", schemas: [], agent: false });
    expect((view.getByLabelText("Schema public") as HTMLButtonElement).getAttribute("aria-checked")).toBe("true");
    expect((view.getByLabelText("Schema sales") as HTMLButtonElement).getAttribute("aria-checked")).toBe("false");
    expect(view.queryByTestId("provision-plan")).toBeNull();
    expect(button(view, "Provision").disabled).toBe(true);
  });

  // The plan is the whole point of the dialog: every statement with the password masked,
  // the destination spelled out, and nothing run until the admin has seen it.
  test("shows the plan for the chosen profile, schemas and agent, with the typed bootstrap credential", async () => {
    const view = await renderOpen();

    fireEvent.click(view.getByLabelText("Read and write"));
    fireEvent.click(view.getByLabelText("Schema sales"));
    fireEvent.click(view.getByLabelText("Agent account"));
    fireEvent.change(view.getByLabelText("DBA user"), { target: { value: "dba" } });
    fireEvent.change(view.getByLabelText("DBA password"), { target: { value: "secret" } });
    // The path field appears once the first read said where the default is, as its placeholder.
    expect((view.getByLabelText(/Vault path for the password/) as HTMLInputElement).placeholder).toBe(
      "dbportal/datasources/shop",
    );
    fireEvent.change(view.getByLabelText(/Vault path for the password/), { target: { value: " dbportal/prod/shop " } });
    await act(async () => {
      fireEvent.click(button(view, "Show the plan"));
    });
    await waitFor(() => {
      if (!view.queryByTestId("provision-plan")) throw new Error("no plan yet");
    });

    expect(bodies[1]).toEqual({
      profile: "readwrite",
      schemas: ["public", "sales"],
      agent: true,
      bootstrap: { user: "dba", password: "secret" },
      vaultPath: "dbportal/prod/shop",
    });
    const shown = view.getByTestId("provision-plan").textContent ?? "";
    expect(shown).toContain("PASSWORD '********'");
    expect(shown).not.toContain("PASSWORD 'x'");
    expect(shown).toContain("(optional)");
    expect(shown).toContain("written to Vault at dbportal/datasources/shop");
    expect(shown).toContain("will be created");
    expect(button(view, "Provision").disabled).toBe(false);
  });

  // Unticking a schema removes it; with none left there is nothing to plan.
  test("keeps Show the plan off while no schema is ticked", async () => {
    const view = await renderOpen();
    fireEvent.click(view.getByLabelText("Schema public"));
    expect(button(view, "Show the plan").disabled).toBe(true);
  });

  // A blocker is a reason the plan cannot run; it is shown and the run stays off.
  test("shows the blockers and keeps Provision off while there is one", async () => {
    const view = await renderOpen({
      plan: (body) =>
        (body.schemas as string[]).length === 0
          ? {
              inventory: { ...inventory, canCreateRole: false, roleExists: true },
              plan,
              destination: { kind: "store" },
            }
          : {
              inventory: { ...inventory, canCreateRole: false, roleExists: true },
              plan: { ...plan, blockers: ["app cannot create roles"], notes: ["CONNECTION_ADMIN is not granted"] },
              destination: { kind: "store" },
            },
    });
    await act(async () => {
      fireEvent.click(button(view, "Show the plan"));
    });
    await waitFor(() => {
      if (!view.queryByTestId("provision-blockers")) throw new Error("no blockers yet");
    });

    expect(view.getByTestId("provision-blockers").textContent).toContain("app cannot create roles");
    expect(view.getByTestId("provision-notes").textContent).toContain("CONNECTION_ADMIN is not granted");
    expect(view.getByTestId("provision-plan").textContent).toContain("(cannot create accounts)");
    expect(view.getByTestId("provision-plan").textContent).toContain("exists, its password will be rotated");
    expect(view.getByTestId("provision-plan").textContent).toContain("sealed at rest");
    // No Vault, no path to choose.
    expect(view.queryByLabelText(/Vault path for the password/)).toBeNull();
    expect(button(view, "Rotate and apply").disabled).toBe(true);
  });

  // A completed run: each statement's outcome listed, the parent told to re-read, the typed
  // credential cleared so a second look at the dialog cannot reuse it.
  test("runs the plan, reports every outcome, clears the bootstrap credential and tells the parent", async () => {
    let told = 0;
    const view = await renderOpen(undefined, () => {
      told += 1;
    });
    fireEvent.change(view.getByLabelText("DBA user"), { target: { value: "dba" } });
    fireEvent.change(view.getByLabelText("DBA password"), { target: { value: "secret" } });
    await act(async () => {
      fireEvent.click(button(view, "Show the plan"));
    });
    await waitFor(() => {
      if (!view.queryByTestId("provision-plan")) throw new Error("no plan yet");
    });
    await act(async () => {
      fireEvent.click(button(view, "Provision"));
    });
    await waitFor(() => {
      if (!view.queryByTestId("provision-report")) throw new Error("no report yet");
    });

    expect(paths).toEqual(["plan", "plan", "run"]);
    expect(bodies[2]).toMatchObject({ bootstrap: { user: "dba", password: "secret" }, schemas: ["public"] });
    expect(view.getByTestId("provision-report").textContent).toContain("Provisioned dbportal_shop.");
    expect(view.getByTestId("provision-report").textContent).toContain("[ran] GRANT pg_monitor");
    expect(mockToastSuccess).toHaveBeenCalledWith("Account dbportal_shop provisioned");
    expect(told).toBe(1);
    expect((view.getByLabelText("DBA user") as HTMLInputElement).value).toBe("");
    expect((view.getByLabelText("DBA password") as HTMLInputElement).value).toBe("");
    expect(button(view, "Provision").disabled).toBe(true);
    expect(view.queryByTestId("provision-references")).toBeNull();
  });

  // A stopped run answers 409 with a report, not an error: the refused statement and the
  // skipped rest are shown so the admin knows how far it got.
  test("shows a stopped run's refused and skipped statements, and the agent role when both were made", async () => {
    const view = await renderOpen({
      run: () => ({
        status: 409,
        json: {
          roleName: "dbportal_shop",
          agentRoleName: "dbportal_shop_agent",
          statements: [
            { ...plan.statements[0], outcome: "ran" },
            { ...plan.statements[1], outcome: "refused", error: "permission denied" },
            {
              shown: "GRANT CONNECT ON DATABASE shop TO dbportal_shop",
              purpose: "Connect",
              account: "portal",
              outcome: "skipped",
            },
          ],
          completed: false,
          destination: vault,
        },
      }),
    });
    await act(async () => {
      fireEvent.click(button(view, "Show the plan"));
    });
    await waitFor(() => {
      if (!view.queryByTestId("provision-plan")) throw new Error("no plan yet");
    });
    await act(async () => {
      fireEvent.click(button(view, "Provision"));
    });
    await waitFor(() => {
      if (!view.queryByTestId("provision-report")) throw new Error("no report yet");
    });

    const text = view.getByTestId("provision-report").textContent ?? "";
    expect(text).toContain("The plan stopped");
    expect(text).toContain("[refused] GRANT pg_monitor TO dbportal_shop — permission denied");
    expect(text).toContain("[skipped] GRANT CONNECT");
    expect(mockToastError).toHaveBeenCalled();
    expect(button(view, "Provision").disabled).toBe(false);
  });

  // A seed-file datasource cannot be rewritten by the portal: the run answers the Vault
  // references, and the dialog shows exactly what to paste into the file.
  test("shows the references to paste when the datasource is declared in the seed file", async () => {
    const view = await renderOpen({
      plan: () => ({
        inventory,
        plan,
        destination: { kind: "seed-file", mount: "dbportal", path: "datasources/shop" },
      }),
      run: () => ({
        roleName: "dbportal_shop",
        agentRoleName: "dbportal_shop_agent",
        statements: [],
        completed: true,
        destination: { kind: "seed-file", mount: "dbportal", path: "datasources/shop" },
        references: {
          user: "vault:kv:dbportal/datasources/shop#user",
          password: "vault:kv:dbportal/datasources/shop#password",
          agentUser: "vault:kv:dbportal/datasources/shop#agent_user",
          agentPassword: "vault:kv:dbportal/datasources/shop#agent_password",
        },
      }),
    });
    await act(async () => {
      fireEvent.click(button(view, "Show the plan"));
    });
    await waitFor(() => {
      if (!view.queryByTestId("provision-plan")) throw new Error("no plan yet");
    });
    expect(view.getByTestId("provision-plan").textContent).toContain("declared in the seed file");
    await act(async () => {
      fireEvent.click(button(view, "Provision"));
    });
    await waitFor(() => {
      if (!view.queryByTestId("provision-references")) throw new Error("no references yet");
    });

    const text = view.getByTestId("provision-references").textContent ?? "";
    expect(text).toContain('password: "vault:kv:dbportal/datasources/shop#password"');
    expect(text).toContain('agentPassword: "vault:kv:dbportal/datasources/shop#agent_password"');
    expect(view.getByTestId("provision-report").textContent).toContain(
      "Provisioned dbportal_shop and dbportal_shop_agent.",
    );
  });

  // A refusal from the server (the datasource is not PostgreSQL, Vault is down) is shown
  // in the dialog with the server's message; a body that is not JSON falls back to the status.
  test("shows the server's refusal on open, on the plan and on the run", async () => {
    const view = await renderOpen({ plan: () => ({ status: 403, json: { error: "Only a PostgreSQL datasource" } }) });
    expect(view.getByTestId("provision-error").textContent).toBe("Only a PostgreSQL datasource");
    expect(view.getByTestId("provision-no-schemas").textContent).toBe("No schema was read yet.");
    cleanup();
    restoreGlobalFetch();

    mockGlobalFetch({
      "/api/admin/datasources/shop/account/plan": { ok: true, json: { inventory, plan, destination: vault } },
      "/api/admin/datasources/shop/account": { status: 502, text: "bad gateway" },
    });
    const second = render(<ProvisionAccountSheet open onOpenChange={() => {}} datasource={datasource} />);
    await waitFor(() => {
      if (!second.queryByTestId("provision-schemas")) throw new Error("still reading");
    });
    await act(async () => {
      fireEvent.click(button(second, "Show the plan"));
    });
    await waitFor(() => {
      if (!second.queryByTestId("provision-plan")) throw new Error("no plan yet");
    });
    await act(async () => {
      fireEvent.click(button(second, "Provision"));
    });
    await waitFor(() => {
      if (!second.queryByTestId("provision-error")) throw new Error("no error yet");
    });
    expect(second.getByTestId("provision-error").textContent).toBe("HTTP 502");
    cleanup();
    restoreGlobalFetch();

    // A plan that fails after open: the answer is not an Error instance either.
    let calls = 0;
    mockGlobalFetch({
      "/api/admin/datasources/shop/account/plan": () => {
        calls += 1;
        if (calls === 1) return { ok: true, json: { inventory, plan, destination: vault } };
        throw "network down";
      },
    });
    const third = render(<ProvisionAccountSheet open onOpenChange={() => {}} datasource={datasource} />);
    await waitFor(() => {
      if (!third.queryByTestId("provision-schemas")) throw new Error("still reading");
    });
    await act(async () => {
      fireEvent.click(button(third, "Show the plan"));
    });
    await waitFor(() => {
      if (!third.queryByTestId("provision-error")) throw new Error("no error yet");
    });
    expect(third.getByTestId("provision-error").textContent).toBe("network down");
  });

  // Closing clears the typed credential and the reports; a closed or datasource-less
  // dialog reads nothing.
  test("clears the credential on close and reads nothing while closed or without a datasource", async () => {
    const opens: boolean[] = [];
    const fetchMock = mockGlobalFetch(routes());
    const view = render(
      <ProvisionAccountSheet open onOpenChange={(next) => opens.push(next)} datasource={datasource} />,
    );
    await waitFor(() => {
      if (!view.queryByTestId("provision-schemas")) throw new Error("still reading");
    });
    fireEvent.change(view.getByLabelText("DBA password"), { target: { value: "secret" } });
    fireEvent.click(view.getByTestId("provision-close"));
    expect(opens).toEqual([false]);
    expect((view.getByLabelText("DBA password") as HTMLInputElement).value).toBe("");

    view.rerender(<ProvisionAccountSheet open={false} onOpenChange={() => {}} datasource={datasource} />);
    view.rerender(<ProvisionAccountSheet open onOpenChange={() => {}} datasource={null} />);
    await act(async () => {});
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(view.getByText("The portal's own account on the datasource")).toBeTruthy();
  });

  // The bootstrap hint follows the engine: ownership on PostgreSQL, the grant option on MySQL.
  test("tells a MySQL datasource's admin what the bootstrap needs there", async () => {
    mockGlobalFetch(routes());
    const view = render(
      <ProvisionAccountSheet open onOpenChange={() => {}} datasource={{ ...datasource, type: "mysql" }} />,
    );
    await waitFor(() => {
      if (!view.queryByTestId("provision-schemas")) throw new Error("still reading");
    });
    expect(view.getByTestId("provision-account-sheet").textContent).toContain("WITH GRANT OPTION");
    expect(view.getByTestId("provision-account-sheet").textContent).not.toContain("OWNS the tables");
  });

  // An unmount mid-read leaves no state update behind.
  test("drops an answer that lands after the dialog was unmounted", async () => {
    let release: (() => void) | null = null;
    mockGlobalFetch({
      "/api/admin/datasources/shop/account/plan": () =>
        new Promise((resolve) => {
          release = () => resolve({ ok: true, json: { inventory, plan, destination: vault } });
        }),
    });
    const view = render(<ProvisionAccountSheet open onOpenChange={() => {}} datasource={datasource} />);
    await waitFor(() => {
      if (!release) throw new Error("not asked yet");
    });
    expect(view.getByTestId("provision-no-schemas").textContent).toBe("Reading the database…");
    view.unmount();
    await act(async () => {
      release!();
    });
  });
});
