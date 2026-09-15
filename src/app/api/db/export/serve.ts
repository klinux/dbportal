import { NextResponse } from "next/server";
import type { ExportResult } from "@/lib/export/request";
import type { JobRecord } from "@/lib/storage/types";

/** The finished job as a download, or what stopped it (docs/CONTEXT.md §4.40). Shared by the two export routes. */
export function serveExport(job: JobRecord, file: { result: ExportResult; content: Buffer } | null): NextResponse {
  if (job.status === "done" && file) {
    return new NextResponse(new Uint8Array(file.content), {
      status: 200,
      headers: {
        "Content-Type": file.result.mimeType,
        "Content-Disposition": `attachment; filename="export.${file.result.extension}"`,
        "X-Export-Rows": String(file.result.rows),
        "X-Export-Extension": file.result.extension,
        "X-Export-Job": job.id,
      },
    });
  }
  if (job.status === "done") {
    return NextResponse.json(
      { error: "The export's file is no longer on the server", statusCode: 410 },
      { status: 410 },
    );
  }
  const why =
    job.status === "lost"
      ? "The worker building the export stopped answering"
      : `The export did not run (${job.error ?? "error"})`;
  return NextResponse.json({ error: why, statusCode: 500 }, { status: 500 });
}
