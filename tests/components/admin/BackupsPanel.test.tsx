import "../../setup-dom";
import { mockToastSuccess, mockToastError, mockToastInfo } from "../../helpers/mock-sonner";
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { render, fireEvent, cleanup, waitFor, act } from "@testing-library/react";
import { mockGlobalFetch, restoreGlobalFetch } from "../../helpers/mock-fetch";
import { BACKUP_POLL_MS, BackupsPanel, formatSize } from "@/components/admin/BackupsPanel";

/**
 * The backups panel (docs/CONTEXT.md §4.14): what the server's answer lets it offer - a
 * backup now, the files, a restore only where allowed - and the words for an engine without
 * backups, a server without the tool, and a failed read. A backup the server queued (§4.40)
 * is polled to its end, and one found open on load is followed the same way.
 */
const ready = {
  supported: true,
  tool: true,
  restoreAllowed: true,
  bucket: false,
  backups: [{ name: "2026-03-01T00-00-00Z.dump", size: 2048, createdAt: "x" }],
};

async function renderLoaded(props = { datasourceId: "orders", datasourceName: "Orders" }) {
  const result = render(<BackupsPanel {...props} />);
  await waitFor(() => {
    if (result.queryByTestId("backups-loading")) throw new Error("still loading");
  });
  return result;
}
const calls = (fetchMock: ReturnType<typeof mockGlobalFetch>, method: string) =>
  fetchMock.mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method === method);

describe("BackupsPanel", () => {
  beforeEach(() => {
    mockToastSuccess.mockClear();
    mockToastError.mockClear();
    mockToastInfo.mockClear();
  });

  afterEach(() => {
    cleanup();
    restoreGlobalFetch();
  });

  test("lists the files with their size and offers a restore where allowed; production has no restore", async () => {
    mockGlobalFetch({ "/api/admin/backups": { ok: true, json: ready } });
    const { getByTestId, getByLabelText, getByText } = await renderLoaded();
    expect(getByTestId("backup-2026-03-01T00-00-00Z.dump").textContent).toContain("2.0 kB");
    expect(getByLabelText("Restore 2026-03-01T00-00-00Z.dump")).not.toBeNull();
    expect(getByText(/not production/)).not.toBeNull();
    cleanup();
    restoreGlobalFetch();
    mockGlobalFetch({ "/api/admin/backups": { ok: true, json: { ...ready, restoreAllowed: false, bucket: true } } });
    const prod = await renderLoaded({ datasourceId: "prod", datasourceName: "Prod" });
    expect(prod.queryByLabelText("Restore 2026-03-01T00-00-00Z.dump")).toBeNull();
    expect(prod.getByText(/not offered on a production/)).not.toBeNull();
    expect(prod.getByText(/copied to the bucket/)).not.toBeNull();
  });

  test("an unsupported engine, a missing tool, an empty list and a failed read each say so, and the button follows", async () => {
    mockGlobalFetch({ "/api/admin/backups": { ok: true, json: { ...ready, supported: false } } });
    let view = await renderLoaded();
    expect(view.getByText(/PostgreSQL datasources only/)).not.toBeNull();
    expect((view.getByText("Back up now").closest("button") as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    restoreGlobalFetch();
    mockGlobalFetch({ "/api/admin/backups": { ok: true, json: { ...ready, tool: false } } });
    view = await renderLoaded();
    expect(view.getByText(/pg_dump is not installed/)).not.toBeNull();
    cleanup();
    restoreGlobalFetch();
    mockGlobalFetch({ "/api/admin/backups": { ok: true, json: { ...ready, backups: [] } } });
    view = await renderLoaded();
    expect(view.getByTestId("backups-empty")).not.toBeNull();
    cleanup();
    restoreGlobalFetch();
    mockGlobalFetch({ "/api/admin/backups": { ok: false, status: 500, json: { error: "disk" } } });
    const failed = render(<BackupsPanel datasourceId="orders" datasourceName="Orders" />);
    expect((await failed.findByTestId("backups-error")).textContent).toContain("disk");
  });

  test("Back up now posts the datasource, reports the file or the bucket copy, and reloads; a refusal is shown", async () => {
    let bucket = false;
    let refuse = false;
    const fetchMock = mockGlobalFetch({
      "/api/admin/backups": (req) =>
        req.method === "POST"
          ? refuse
            ? { ok: false, status: 503, json: { error: "pg_dump is not installed" } }
            : {
              ok: true,
              status: 201,
              json: { action: "create", status: "done", backup: { name: "n.dump", ...(bucket ? { object: "o" } : {}) } },
            }
          : { ok: true, json: ready },
    });
    const { getByText } = await renderLoaded();
    await act(async () => {
      fireEvent.click(getByText("Back up now"));
    });
    expect(JSON.parse((calls(fetchMock, "POST")[0][1] as RequestInit).body as string)).toEqual({
      datasourceId: "orders",
    });
    expect(mockToastSuccess).toHaveBeenCalledWith("Backup n.dump taken");
    bucket = true;
    await act(async () => {
      fireEvent.click(getByText("Back up now"));
    });
    expect(mockToastSuccess).toHaveBeenCalledWith("Backup taken and copied to the bucket");
    refuse = true;
    await act(async () => {
      fireEvent.click(getByText("Back up now"));
    });
    expect(mockToastError).toHaveBeenCalledWith("pg_dump is not installed");
    fireEvent.click(getByText("Refresh"));
  });

  test("a restore asks first, then posts the file's name; a refusal is shown in the server's words", async () => {
    let refuse = false;
    const fetchMock = mockGlobalFetch({
      "/api/admin/backups/restore": () =>
        refuse
          ? { ok: false, status: 403, json: { error: "not offered" } }
          : { ok: true, json: { action: "restore", status: "done", backup: { name: "x" } } },
      "/api/admin/backups": { ok: true, json: ready },
    });
    const { getByLabelText, getByText, getByRole, queryByText } = await renderLoaded();
    fireEvent.click(getByLabelText("Restore 2026-03-01T00-00-00Z.dump"));
    expect(getByText("Restore this backup?")).not.toBeNull();
    fireEvent.click(getByText("Cancel", { selector: "button" }));
    await waitFor(() => {
      if (queryByText("Restore this backup?")) throw new Error("still open");
    });
    expect(calls(fetchMock, "POST")).toHaveLength(0);
    fireEvent.click(getByLabelText("Restore 2026-03-01T00-00-00Z.dump"));
    await act(async () => {
      fireEvent.click(getByRole("button", { name: "Restore" }));
    });
    expect(JSON.parse((calls(fetchMock, "POST")[0][1] as RequestInit).body as string)).toEqual({
      datasourceId: "orders",
      name: "2026-03-01T00-00-00Z.dump",
    });
    expect(mockToastSuccess).toHaveBeenCalledWith('"Orders" restored from 2026-03-01T00-00-00Z.dump');
    refuse = true;
    fireEvent.click(getByLabelText("Restore 2026-03-01T00-00-00Z.dump"));
    await act(async () => {
      fireEvent.click(getByRole("button", { name: "Restore" }));
    });
    expect(mockToastError).toHaveBeenCalledWith("not offered");
  });

  test("a backup the server queued is polled until a worker wrote it, and a failure is told in the server's words", async () => {
    let polls = 0;
    let outcome: { status: number; json: Record<string, unknown> } = {
      status: 200,
      json: { jobId: "job-1", action: "create", status: "done", backup: { name: "q.dump" } },
    };
    const fetchMock = mockGlobalFetch({
      "/api/admin/backups/job-1": () => {
        polls += 1;
        return polls === 1
          ? { ok: true, status: 202, json: { jobId: "job-1", action: "create", status: "running" } }
          : { ok: outcome.status < 400, status: outcome.status, json: outcome.json };
      },
      "/api/admin/backups": (req) =>
        req.method === "POST"
          ? { ok: true, status: 202, json: { jobId: "job-1", action: "create", status: "queued" } }
          : { ok: true, json: ready },
    });
    const { getByText } = await renderLoaded();
    await act(async () => {
      fireEvent.click(getByText("Back up now"));
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(mockToastInfo).toHaveBeenCalledWith("Backup queued; a worker is taking it");
    expect(mockToastSuccess).not.toHaveBeenCalled();
    await act(async () => {
      await new Promise((r) => setTimeout(r, BACKUP_POLL_MS * 2 + 200));
    });
    expect(polls).toBe(2);
    expect(mockToastSuccess).toHaveBeenCalledWith("Backup q.dump taken");
    // The list is read again once the file is there.
    expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes("datasourceId=orders")).length).toBe(2);
    polls = 0;
    outcome = { status: 502, json: { jobId: "job-1", action: "create", status: "failed", error: "pg_dump failed" } };
    await act(async () => {
      fireEvent.click(getByText("Back up now"));
      await new Promise((r) => setTimeout(r, BACKUP_POLL_MS * 2 + 200));
    });
    expect(mockToastError).toHaveBeenCalledWith("pg_dump failed");
    // A failure the server did not word gets the panel's own.
    polls = 0;
    outcome = { status: 500, json: { jobId: "job-1", action: "create", status: "lost" } };
    await act(async () => {
      fireEvent.click(getByText("Back up now"));
      await new Promise((r) => setTimeout(r, BACKUP_POLL_MS * 2 + 200));
    });
    expect(mockToastError).toHaveBeenCalledWith("The backup failed");
  }, 20_000);

  test("a job found open on load is followed to its end, the button held meanwhile", async () => {
    let polls = 0;
    mockGlobalFetch({
      "/api/admin/backups/job-5": () => {
        polls += 1;
        return { ok: true, json: { jobId: "job-5", action: "restore", status: "done", backup: { name: "r.dump" } } };
      },
      "/api/admin/backups": { ok: true, json: { ...ready, job: { jobId: "job-5", action: "restore", status: "running" } } },
    });
    const { getByText } = await renderLoaded();
    expect((getByText("Back up now").closest("button") as HTMLButtonElement).disabled).toBe(true);
    await act(async () => {
      await new Promise((r) => setTimeout(r, BACKUP_POLL_MS + 200));
    });
    expect(polls).toBe(1);
    expect(mockToastSuccess).toHaveBeenCalledWith('"Orders" restored from r.dump');
    expect((getByText("Back up now").closest("button") as HTMLButtonElement).disabled).toBe(false);
  }, 10_000);

  test("formatSize picks the unit", () => {
    expect(formatSize(12)).toBe("12 B");
    expect(formatSize(2048)).toBe("2.0 kB");
    expect(formatSize(3 * 1024 * 1024)).toBe("3.0 MB");
  });
});
