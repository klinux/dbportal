"use client";

import { appFetch } from "@/lib/config/base-path";
import { useEffect, useState } from "react";
import type { KnownPrincipal } from "@/lib/principal-kind";

/** The principals the deployment already knows (docs/CONTEXT.md §4.37); empty until the server answers or when it cannot. */
export function useKnownPrincipals(): KnownPrincipal[] {
  const [principals, setPrincipals] = useState<KnownPrincipal[]>([]);
  useEffect(() => {
    let ignore = false;
    appFetch("/api/admin/principals")
      .then(async (res) => {
        if (!res.ok) return;
        const body = (await res.json()) as { principals?: KnownPrincipal[] };
        if (!ignore && Array.isArray(body.principals)) setPrincipals(body.principals);
      })
      .catch(() => {});
    return () => {
      ignore = true;
    };
  }, []);
  return principals;
}
