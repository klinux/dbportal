"use client";

import { appFetch } from "@/lib/config/base-path";
import { useEffect, useState } from "react";
import type { ChannelSummary } from "@/lib/seed/types";

/** The channels an alert may name (docs/CONTEXT.md §4.29): id, name and kind, as the server lists them. One read per mount. */
export function useChannels(): ChannelSummary[] {
  const [channels, setChannels] = useState<ChannelSummary[]>([]);
  useEffect(() => {
    let ignore = false;
    appFetch("/api/channels")
      .then(async (res) => {
        if (!res.ok) return;
        const body = (await res.json()) as { channels?: ChannelSummary[] };
        if (!ignore && Array.isArray(body.channels)) setChannels(body.channels);
      })
      .catch(() => {});
    return () => {
      ignore = true;
    };
  }, []);
  return channels;
}
