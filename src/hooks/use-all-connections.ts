"use client";

import { appFetch } from "@/lib/config/base-path";
import { useState, useEffect } from "react";
import type { DatabaseConnection } from "@/lib/types";

/**
 * Every datasource this session may open, from the server (`GET /api/connections/managed`).
 * There is no browser-held list to merge any more (docs/CONTEXT.md §4.1): a datasource is
 * declared by an administrator and opened by its seed id.
 *
 * A lightweight alternative to useConnectionManager — it only fetches, without active
 * connection state, schema loading, or health checks.
 */
export function useAllConnections() {
  const [connections, setConnections] = useState<DatabaseConnection[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    appFetch("/api/connections/managed")
      .then(async (res) => {
        if (!res.ok) return [];
        const { connections: managed } = (await res.json()) as {
          connections?: Array<Omit<DatabaseConnection, "createdAt"> & { createdAt: string }>;
        };
        const list: DatabaseConnection[] = [];
        for (const mc of managed ?? []) list.push({ ...mc, createdAt: new Date(mc.createdAt) });
        return list;
      })
      .catch(() => [] as DatabaseConnection[])
      .then((list) => {
        if (cancelled) return;
        setConnections(list);
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return { connections, loading };
}
