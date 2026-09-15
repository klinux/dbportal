import "../../setup-dom";
import { mockToastSuccess, mockToastError, mockToastInfo } from "../../helpers/mock-sonner";
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { render, fireEvent, cleanup, waitFor, act } from "@testing-library/react";
import { mockGlobalFetch, restoreGlobalFetch } from "../../helpers/mock-fetch";
import { JobsTab, PING_WAIT_MS, formatMs } from "@/components/admin/tabs/JobsTab";

/**
 * The Jobs section (docs/CONTEXT.md §4.40): the queue's numbers as the server answers them
 * - now, over the window, by kind, the workers - the latest jobs filtered by status, the
 * window and the filter re-read from the server, a ping told as a round trip or as nobody
 * home, and a failed read said in the server's words.
 */
const stats = {
  since: "2026-09-14T12:00:00.000Z",
  hours: 24,
  sample: 12,
  queued: 3,
  running: 1,
  total: 8,
  done: 6,
  failed: 1,
  lost: 1,
  wait: { p50Ms: 850, p95Ms: 4_200, maxMs: 9_000 },
  run: { p50Ms: 61_000, p95Ms: 125_000, maxMs: 125_000 },
  kinds: [
    { kind: "export", total: 5, done: 5, failed: 0, lost: 0, wait: { p50Ms: 850, p95Ms: 900, maxMs: 900 }, run: null },
    {
      kind: "backup",
      total: 3,
      done: 1,
      failed: 1,
      lost: 1,
      wait: null,
      run: { p50Ms: 61_000, p95Ms: 125_000, maxMs: 125_000 },
    },
  ],
  workers: [{ name: "worker-1:42", jobs: 8, lastSeenAt: "2026-09-15T11:59:00.000Z" }],
  leases: [],
  instance: "studio-a:7",
  schedulerLeader: "studio-a:7",
};
const job = {
  id: "0a1b2c3d-rest",
  kind: "export",
  payload: {},
  status: "done",
  attempts: 1,
  maxAttempts: 1,
  requestedBy: "ana",
  createdAt: "2026-09-15T11:58:00.000Z",
  runAt: "2026-09-15T11:58:00.000Z",
  startedAt: "2026-09-15T11:58:01.000Z",
  finishedAt: "2026-09-15T11:58:03.500Z",
  worker: "worker-1:42",
};

async function renderLoaded() {
  const result = render(<JobsTab />);
  await waitFor(() => {
    if (result.queryByTestId("jobs-loading")) throw new Error("still loading");
  });
  return result;
}
const urls = (fetchMock: ReturnType<typeof mockGlobalFetch>) => fetchMock.mock.calls.map((c) => String(c[0]));

describe("JobsTab", () => {
  beforeEach(() => {
    mockToastSuccess.mockClear();
    mockToastError.mockClear();
    mockToastInfo.mockClear();
  });

  afterEach(() => {
    cleanup();
    restoreGlobalFetch();
  });

  test("draws the numbers now, the window, the kinds, the workers and the latest jobs", async () => {
    const fetchMock = mockGlobalFetch({
      "/api/admin/jobs/stats": { ok: true, json: stats },
      "/api/admin/jobs": {
        ok: true,
        json: {
          counts: {},
          jobs: [
            job,
            { ...job, id: "lost-1", status: "lost", worker: undefined, error: "lease" },
            { ...job, id: "q-1", status: "queued", startedAt: undefined, finishedAt: undefined, worker: undefined },
          ],
        },
      },
    });
    const { getByTestId, getByText } = await renderLoaded();
    expect(getByTestId("stat-queued").textContent).toContain("3");
    expect(getByTestId("stat-running").textContent).toContain("1");
    expect(getByTestId("stat-total").textContent).toContain("8");
    expect(getByTestId("stat-failed").textContent).toContain("2");
    expect(getByTestId("stat-failed").textContent).toContain("1 lost");
    expect(getByTestId("stat-wait").textContent).toContain("850 ms / 4.2 s");
    expect(getByTestId("stat-run").textContent).toContain("1m 01s / 2m 05s");
    expect(getByTestId("kind-export").textContent).toContain("850 ms / 900 ms");
    expect(getByTestId("kind-backup").textContent).toContain("– / –");
    expect(getByText("worker-1:42", { selector: "span" })).not.toBeNull();
    // The alert scheduler's leader (§4.41), and that it is the instance that answered.
    expect(getByTestId("scheduler-leader").textContent).toContain("studio-a:7 (this instance)");
    expect(getByTestId("scheduler-leader").textContent).toContain("Answered by studio-a:7");
    expect(getByTestId("job-0a1b2c3d-rest").textContent).toContain("2.5 s");
    expect(getByTestId("job-lost-1").textContent).toContain("lease");
    // A job nobody took yet has neither a wait nor a run to show.
    expect(getByTestId("job-q-1").textContent).toContain("–––");
    expect(urls(fetchMock)).toEqual(["/api/admin/jobs/stats?hours=24", "/api/admin/jobs?limit=50"]);
  });

  test("the window and the status filter re-read the server; refresh reads again", async () => {
    const fetchMock = mockGlobalFetch({
      "/api/admin/jobs/stats": { ok: true, json: { ...stats, kinds: [], workers: [], schedulerLeader: null } },
      "/api/admin/jobs": { ok: true, json: { counts: {}, jobs: [] } },
    });
    const { getByText, getByTestId } = await renderLoaded();
    expect(getByTestId("kinds-empty")).not.toBeNull();
    expect(getByTestId("workers-empty")).not.toBeNull();
    expect(getByTestId("scheduler-leader").textContent).toContain("no leader yet");
    expect(getByTestId("jobs-empty").textContent).toContain("No job yet");
    await act(async () => {
      fireEvent.click(getByText("7 d"));
    });
    await act(async () => {
      fireEvent.click(getByText("failed"));
    });
    await act(async () => {
      fireEvent.click(getByText("Refresh"));
    });
    expect(urls(fetchMock).filter((u) => u.includes("stats"))).toEqual([
      "/api/admin/jobs/stats?hours=24",
      "/api/admin/jobs/stats?hours=168",
      "/api/admin/jobs/stats?hours=168",
      "/api/admin/jobs/stats?hours=168",
    ]);
    expect(urls(fetchMock).filter((u) => u.includes("status="))).toEqual([
      "/api/admin/jobs?limit=50&status=failed",
      "/api/admin/jobs?limit=50&status=failed",
    ]);
    expect(getByTestId("jobs-empty").textContent).toContain("No job failed");
  });

  test("a ping is told as the round trip when a worker answered, as nobody home when none did, and refused in the server's words", async () => {
    let answered = true;
    let refuse = false;
    mockGlobalFetch({
      "/api/admin/jobs/stats": { ok: true, json: stats },
      "/api/admin/jobs/ping": () =>
        refuse
          ? { ok: false, status: 503, json: { error: "Jobs need server storage" } }
          : { ok: true, status: 202, json: { job: { ...job, id: "ping-1", kind: "ping", status: "queued" } } },
      "/api/admin/jobs": (req) =>
        new URL(req.url).searchParams.get("kind") === "ping"
          ? {
              ok: true,
              json: {
                counts: {},
                jobs: [
                  answered
                    ? { ...job, id: "ping-1", kind: "ping" }
                    : { ...job, id: "ping-1", kind: "ping", status: "queued" },
                ],
              },
            }
          : { ok: true, json: { counts: {}, jobs: [] } },
    });
    const { getByText } = await renderLoaded();
    await act(async () => {
      fireEvent.click(getByText("Ping a worker"));
      await new Promise((r) => setTimeout(r, PING_WAIT_MS + 100));
    });
    expect(mockToastSuccess).toHaveBeenCalledWith("A worker answered in 3.5 s (worker-1:42)");
    answered = false;
    await act(async () => {
      fireEvent.click(getByText("Ping a worker"));
      await new Promise((r) => setTimeout(r, PING_WAIT_MS + 100));
    });
    expect(mockToastInfo).toHaveBeenCalledWith("No worker answered within 3 s; the ping is queued");
    refuse = true;
    await act(async () => {
      fireEvent.click(getByText("Ping a worker"));
    });
    expect(mockToastError).toHaveBeenCalledWith("Jobs need server storage");
  }, 15_000);

  test("a failed read is said in the server's words", async () => {
    mockGlobalFetch({
      "/api/admin/jobs/stats": { ok: false, status: 503, json: { error: "Jobs need server storage" } },
      "/api/admin/jobs": { ok: true, json: { counts: {}, jobs: [] } },
    });
    const view = render(<JobsTab />);
    expect((await view.findByTestId("jobs-error")).textContent).toContain("Jobs need server storage");
  });

  test("formatMs picks the unit and says nothing for nothing", () => {
    expect(formatMs(null)).toBe("–");
    expect(formatMs(undefined)).toBe("–");
    expect(formatMs(12.4)).toBe("12 ms");
    expect(formatMs(2_340)).toBe("2.3 s");
    expect(formatMs(65_000)).toBe("1m 05s");
  });
});
