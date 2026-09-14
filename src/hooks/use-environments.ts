"use client";

import { appFetch } from "@/lib/config/base-path";
import { useEffect, useState } from "react";
import { BUILTIN_ENVIRONMENTS, type Environment } from "@/lib/types";

/**
 * The environments as the server lists them (docs/CONTEXT.md §4.36), with the built-ins as
 * the answer until it does and if it cannot: nothing in the studio waits on this to draw.
 * One read per mount; the list changes rarely.
 */
export function useEnvironments(): Environment[] {
  const [environments, setEnvironments] = useState<Environment[]>(() => [...BUILTIN_ENVIRONMENTS]);
  useEffect(() => {
    let ignore = false;
    appFetch("/api/environments")
      .then(async (res) => {
        if (!res.ok) return;
        const body = (await res.json()) as { environments?: Environment[] };
        if (!ignore && Array.isArray(body.environments) && body.environments.length > 0)
          setEnvironments(body.environments);
      })
      .catch(() => {});
    return () => {
      ignore = true;
    };
  }, []);
  return environments;
}
