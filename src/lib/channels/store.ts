import { SHARED_CHANNELS_OWNER } from "@/lib/datasources/owner";
import { loadConfig } from "@/lib/seed/config-loader";
import { ChannelSchema, type Channel, type ChannelKind, type ChannelSummary } from "@/lib/seed/types";
import { getStorageProvider, isServerStorageEnabled } from "@/lib/storage/factory";

/**
 * Notification channels (docs/CONTEXT.md §4.29): where an alert fires to, declared once by
 * an administrator - a Slack channel the existing bot posts to, a generic webhook (signed
 * like §4.25 when the signing secret is set), a Grafana OnCall formatted webhook, a Rootly
 * alert source. The seed file's (`channels:`) are read-only here; the rest live in the
 * server store under a reserved owner. The target - a channel id or a URL - is shown to
 * administrators only; the alert editor gets the id, the name and the kind.
 */
export type { Channel, ChannelKind, ChannelSummary };

export interface ChannelRecord extends Channel {
  createdAt: string;
  createdBy: string;
}

export type ChannelSource = "config" | "store";

export class ChannelError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = "ChannelError";
  }
}

const COLLECTION = "notification_channels" as const;
const CACHE_TTL_MS = 5_000;
const STORE_UNAVAILABLE = "Channels need server storage: set STORAGE_PROVIDER to sqlite or postgres";

let cache: { at: number; records: ChannelRecord[] } | null = null;

/** Tests only. */
export function resetChannelsCache(): void {
  cache = null;
}

async function requireProvider() {
  const provider = await getStorageProvider();
  if (!provider) throw new ChannelError(STORE_UNAVAILABLE, 503);
  return provider;
}

async function readStored(): Promise<ChannelRecord[]> {
  if (!isServerStorageEnabled()) return [];
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.records;
  const provider = await requireProvider();
  const rows = (await provider.getCollection(SHARED_CHANNELS_OWNER, COLLECTION)) ?? [];
  cache = { at: Date.now(), records: rows };
  return rows;
}

async function writeAll(records: ChannelRecord[]): Promise<void> {
  const provider = await requireProvider();
  await provider.setCollection(SHARED_CHANNELS_OWNER, COLLECTION, records);
  cache = { at: Date.now(), records };
}

async function declared(): Promise<Channel[]> {
  const config = await loadConfig();
  return config?.channels ?? [];
}

/** Every channel with where it came from; the seed file's first, and first under a shared id. */
export async function listChannels(): Promise<{ channel: Channel | ChannelRecord; source: ChannelSource }[]> {
  const fromConfig = await declared();
  const ids = new Set(fromConfig.map((c) => c.id));
  const stored = (await readStored()).filter((c) => !ids.has(c.id));
  return [
    ...fromConfig.map((channel) => ({ channel, source: "config" as const })),
    ...stored.map((channel) => ({ channel, source: "store" as const })),
  ];
}

export async function findChannel(id: string): Promise<Channel | null> {
  return (await listChannels()).find((e) => e.channel.id === id)?.channel ?? null;
}

export function summarize(channel: Channel): ChannelSummary {
  return { id: channel.id, name: channel.name, kind: channel.kind };
}

function validate(input: unknown): Channel {
  const result = ChannelSchema.safeParse(input);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".") || "channel"}: ${i.message}`).join("; ");
    throw new ChannelError(`Invalid channel: ${issues}`, 400);
  }
  const channel = result.data;
  if (channel.kind !== "slack") {
    let url: URL;
    try {
      url = new URL(channel.target);
    } catch {
      throw new ChannelError("Invalid channel: target must be an absolute https URL", 400);
    }
    if (url.protocol !== "https:") throw new ChannelError("Invalid channel: target must be https", 400);
    if (url.username || url.password) throw new ChannelError("Invalid channel: target may not carry credentials", 400);
  }
  return channel;
}

/** Declare one; an id the seed file or the store already has is refused. */
export async function saveChannel(input: unknown, actor: string): Promise<ChannelRecord> {
  const data = validate(input);
  if (await findChannel(data.id)) throw new ChannelError(`Channel "${data.id}" already exists`, 409);
  const record: ChannelRecord = { ...data, createdAt: new Date().toISOString(), createdBy: actor };
  await writeAll([...(await readStored()), record]);
  return record;
}

/** Delete a stored one, never a seed-file one, and never one an alert still names. */
export async function deleteChannel(id: string, inUse: (id: string) => Promise<boolean>): Promise<ChannelRecord> {
  const records = await readStored();
  const existing = records.find((c) => c.id === id);
  if (!existing) {
    throw new ChannelError(`Channel "${id}" is not declared here (a seed-file one cannot be deleted)`, 404);
  }
  if (await inUse(id)) throw new ChannelError(`Channel "${id}" is still used by an alert`, 409);
  await writeAll(records.filter((c) => c.id !== id));
  return existing;
}
