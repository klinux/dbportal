import { z } from "zod";
import type { DatasourceLimits } from "@/lib/limits";
import type { DatabaseConnection } from "@/lib/types";

// SSLMode matches the union in src/lib/types.ts — NO 'prefer'. Kept in step BY HAND: a zod
// enum is a value, so a mode missing here is not a compile error, it is a seed file the
// server rejects with "invalid enum value" for a mode the product supports.
const SSLModeSchema = z.enum(["disable", "require", "verify-system", "verify-ca", "verify-full"]);

const SSLConfigSchema = z
  .object({
    mode: SSLModeSchema.optional(),
    rejectUnauthorized: z.boolean().optional(),
    caCert: z.string().optional(),
    clientCert: z.string().optional(),
    clientKey: z.string().optional(),
  })
  .optional();

// An environment id (docs/CONTEXT.md §4.36): a built-in or one declared; a slug, not an enum.
const ConnectionEnvironmentSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/, "Must be an environment id");

/** An environment declared once (§4.36): id, label, colour and where it sorts. */
export const EnvironmentSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/),
  label: z.string().min(1).max(24),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Must be a hex colour"),
  order: z.number().int().min(0).max(1000),
});

export type Environment = z.infer<typeof EnvironmentSchema>;

/** Where an alert fires to (docs/CONTEXT.md §4.29): declared once by an administrator. */
export const CHANNEL_KINDS = ["slack", "webhook", "oncall", "rootly"] as const;
export const ChannelSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  name: z.string().min(1).max(64),
  kind: z.enum(CHANNEL_KINDS),
  /** A Slack channel id, or the HTTPS URL the receiver gave. */
  target: z.string().min(1).max(512),
});

export type Channel = z.infer<typeof ChannelSchema>;
export type ChannelKind = Channel["kind"];
/** What anyone signed in may see of a channel: enough to pick it, never where it goes. */
export interface ChannelSummary {
  id: string;
  name: string;
  kind: ChannelKind;
  /** Who declared it; absent for a seed-file one. */
  createdBy?: string;
}

// A principal (docs/CONTEXT.md §4.4): the wildcard, a portal role, `group:<name>` for a
// group the identity provider puts in the token, or `role:<id>` for a named role (§4.19).
// Not an enum any more, because group names are the operator's, not this product's.
const AllowedRoleSchema = z
  .string()
  .regex(
    /^(\*|admin|user|group:[\x21-\x7e]{1,64}|role:[a-z0-9][a-z0-9-]{0,63})$/,
    "Must be *, admin, user, group:<name> or role:<id>",
  );

// Who is in a named role (§4.19): a portal role, an identity provider's group, or one
// person by the username the session carries. Never another named role: one lookup, no
// cycles.
const RoleMemberSchema = z
  .string()
  .regex(
    /^(admin|user|group:[\x21-\x7e]{1,64}|user:[\x21-\x7e]{1,254})$/,
    "Must be admin, user, group:<name> or user:<username>",
  );

/** One value a runbook asks for (docs/CONTEXT.md §4.20); the statement names it as `{{name}}`. */
export const RunbookParamSchema = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/, "Must be a lowercase identifier"),
  label: z.string().min(1).max(64).optional(),
  type: z.enum(["string", "number", "boolean"]),
  /** Absent means required. */
  required: z.boolean().optional(),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
});

export type RunbookParam = z.infer<typeof RunbookParamSchema>;

export const RUNBOOK_PLACEHOLDER = /\{\{\s*([a-z][a-z0-9_]{0,31})\s*\}\}/g;

/**
 * A runbook (docs/CONTEXT.md §4.20): one statement, declared once for one datasource, with
 * the values it asks for named as `{{name}}` and bound by the driver, never written in.
 */
export const RunbookSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
    name: z.string().min(1).max(64),
    description: z.string().max(200).optional(),
    datasource: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
    sql: z.string().min(1).max(20_000),
    params: z.array(RunbookParamSchema).max(20).optional(),
  })
  .refine((r) => new Set((r.params ?? []).map((p) => p.name)).size === (r.params ?? []).length, {
    message: "Parameter names must be unique",
    path: ["params"],
  })
  .refine(
    (r) => {
      const declared = new Set((r.params ?? []).map((p) => p.name));
      return [...r.sql.matchAll(RUNBOOK_PLACEHOLDER)].every((m) => declared.has(m[1]));
    },
    { message: "Every {{placeholder}} in sql must be a declared parameter", path: ["sql"] },
  );

export type Runbook = z.infer<typeof RunbookSchema>;

/** A named role (docs/CONTEXT.md §4.19): an id datasources refer to as `role:<id>`, and who is in it. */
export const NamedRoleSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  name: z.string().min(1).max(64),
  members: z.array(RoleMemberSchema).min(1).max(200),
});

export type NamedRole = z.infer<typeof NamedRoleSchema>;

// Kept in step with DatabaseType in src/lib/types.ts BY HAND: a zod enum is a value,
// so a type-id missing here is not a compile error - it is a seed file the server
// rejects with "invalid enum value" for a connection type the product supports.
const SeedDatabaseType = z.enum([
  "virtual",
  "postgres",
  "mysql",
  "sqlite",
  "mongodb",
  "redis",
  "oracle",
  "mssql",
  "libredb",
  "couchbase",
  "clickhouse",
  "druid",
  "elasticsearch",
  "opensearch",
  "trino",
  "cassandra",
  "libsql",
  "duckdb",
]);

/**
 * A bastion declared once and referenced by any number of datasources (docs/CONTEXT.md §4.9).
 * The secrets take a value, a `${ENV_VAR}` reference or a `vault:kv:` reference, resolved
 * when a datasource that names the profile is opened - never sent to the browser.
 */
export const SshProfileSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "id must be lowercase letters, digits and hyphens"),
  name: z.string().min(1).max(80),
  host: z.string().min(1).max(253),
  port: z.number().int().min(1).max(65535).default(22),
  username: z.string().min(1).max(64),
  authMethod: z.enum(["password", "privateKey"]),
  password: z.string().optional(),
  privateKey: z.string().optional(),
  passphrase: z.string().optional(),
  /** The bastion's host key as `ssh-keygen -lf` prints it; authoritative when set. */
  hostKeyFingerprint: z.string().max(120).optional(),
});

export type SshProfile = z.infer<typeof SshProfileSchema>;

export const SeedDefaultsSchema = z.object({
  managed: z.boolean().optional(),
  environment: ConnectionEnvironmentSchema.optional(),
  ssl: SSLConfigSchema,
});

export const LimitsSchema = z.object({
  maxRows: z.number().int().min(1).max(1_000_000).optional(),
  queryTimeoutMs: z.number().int().min(1).max(2_147_483_647).optional(),
  maxConcurrent: z.number().int().min(1).max(100).optional(),
});

/** A freeze window (docs/CONTEXT.md §4.17): no write between two instants, on the datasources named or on all. */
export const FreezeWindowSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
    reason: z.string().min(1).max(200),
    from: z.string().datetime({ offset: true }),
    until: z.string().datetime({ offset: true }),
    /** Datasource ids; empty or absent means every datasource. */
    datasources: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/)).optional(),
  })
  .refine((w) => Date.parse(w.until) > Date.parse(w.from), { message: "until must be after from", path: ["until"] });

export type FreezeWindow = z.infer<typeof FreezeWindowSchema>;

export const SeedConnectionSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9-]+$/, "ID must be lowercase alphanumeric with hyphens"),
  name: z.string().min(1).max(128),
  type: SeedDatabaseType,
  host: z.string().optional(),
  port: z.number().int().min(1).max(65535).optional(),
  database: z.string().optional(),
  user: z.string().optional(),
  password: z.string().optional(),
  connectionString: z.string().optional(),
  environment: ConnectionEnvironmentSchema.optional(),
  group: z.string().max(64).optional(),
  color: z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/)
    .optional(),
  roles: z.array(AllowedRoleSchema).min(1, "At least one role is required"),
  // Who may WRITE (docs/CONTEXT.md §4.4). Absent: everyone who can open. Empty: nobody -
  // the datasource is read-only for every session, administrators included.
  writeRoles: z.array(AllowedRoleSchema).optional(),
  /** Writes run only inside an approved write window (docs/CONTEXT.md §4.6). */
  writeApproval: z.boolean().optional(),
  /** Who may grant one; administrators when absent. */
  approverRoles: z.array(AllowedRoleSchema).optional(),
  /** Two distinct reviewers before a gated write runs (§4.28); one when absent. */
  approvalsRequired: z.union([z.literal(1), z.literal(2)]).optional(),
  /** Whether DELETE/UPDATE without WHERE, DROP and TRUNCATE need a reviewer even from a writer (§4.15). On unless `false`. */
  guardrails: z.boolean().optional(),
  /** Rows, milliseconds and running statements per person a datasource allows (§4.16). */
  limits: LimitsSchema.optional(),
  /** Writes must name a ticket or incident (§4.18). */
  requireTicket: z.boolean().optional(),
  /** Who may export a result as a file (§4.22); absent: everyone who can open, nobody on production. */
  exportRoles: z.array(AllowedRoleSchema).optional(),
  /** The SSH profile (a bastion declared once) this datasource is reached through (§4.9). */
  sshProfile: z.string().optional(),
  managed: z.boolean().optional(),
  ssl: SSLConfigSchema,
  serviceName: z.string().optional(),
  instanceName: z.string().optional(),
  // Cassandra only, and REQUIRED by that driver rather than optional to it: a seeded
  // Cassandra connection without it cannot open at all. Optional here because the
  // other thirteen type-ids have no use for the field; the provider is what refuses a
  // connection that omits it.
  localDataCenter: z.string().optional(),
  // MongoDB only: the database its credentials live in (`admin` in the ordinary
  // deployment). Optional because the driver falls back to the database being opened,
  // which is right only when the two are the same.
  authSource: z.string().optional(),
  schema: z.string().optional(),
  // Read no catalog when this connection opens (#765). Declarable in the seed file
  // because the deployment that ships a 40,000-object owner is the one that knows, and
  // a managed connection is read-only in the UI, so nobody could tick the box there.
  // Unlike the maps in `connection-secrets.ts` and `use-connection-payload.ts`, this
  // schema fails SILENTLY when a field is missing: zod strips an unknown key, so a seed
  // file setting it would round-trip as `undefined` with no error anywhere.
  skipObjectScan: z.boolean().optional(),
  /**
   * A virtual datasource's members (§4.44): two to eight ids of PostgreSQL or MySQL
   * datasources of the same environment, opened as one. Only on `type: virtual`, which
   * carries no address of its own and is read-only for everyone.
   */
  members: z
    .array(z.string().regex(/^[a-z0-9-]+$/))
    .min(2)
    .max(8)
    .optional(),
}).superRefine((conn, ctx) => {
  const problem = virtualDeclarationError(conn);
  if (problem) ctx.addIssue({ code: "custom", message: problem, path: ["members"] });
});

/** The fields a virtual datasource cannot carry: it has no engine to address and no write to allow. */
export const VIRTUAL_FORBIDDEN_FIELDS = [
  "host",
  "port",
  "database",
  "user",
  "password",
  "connectionString",
  "sshProfile",
  "writeRoles",
  "writeApproval",
  "approverRoles",
  "approvalsRequired",
] as const;

/** The engines a virtual datasource may join (§4.44): the ones the embedded engine attaches. */
export const VIRTUAL_MEMBER_TYPES: ReadonlySet<string> = new Set(["postgres", "mysql"]);

/** What is wrong with a virtual datasource's own declaration, or nothing. */
export function virtualDeclarationError(conn: {
  type: string;
  members?: string[];
  [key: string]: unknown;
}): string | null {
  if (conn.type !== "virtual") return conn.members !== undefined ? "members is only for type: virtual" : null;
  if (!conn.members) return "A virtual datasource needs members";
  if (new Set(conn.members).size !== conn.members.length) return "members must not repeat";
  const carried = VIRTUAL_FORBIDDEN_FIELDS.filter((f) => conn[f] !== undefined);
  if (carried.length > 0) return `A virtual datasource cannot set ${carried.join(", ")}`;
  return null;
}

/**
 * What is wrong with a virtual datasource among the others: a member missing, of an
 * engine the embedded one cannot attach, of another environment, reached through a
 * bastion, or virtual itself.
 */
export function virtualMembersError(
  conn: { id: string; members?: string[]; environment?: string },
  all: readonly { id: string; type: string; environment?: string; sshProfile?: string }[],
  defaultEnvironment?: string,
): string | null {
  const env = conn.environment ?? defaultEnvironment;
  for (const id of conn.members ?? []) {
    const member = all.find((c) => c.id === id);
    if (!member) return `Virtual datasource "${conn.id}" names a member that is not declared: ${id}`;
    if (member.type === "virtual") return `Virtual datasource "${conn.id}" cannot include another virtual one: ${id}`;
    if (!VIRTUAL_MEMBER_TYPES.has(member.type))
      return `Virtual datasource "${conn.id}" can only join PostgreSQL and MySQL; ${id} is ${member.type}`;
    if ((member.environment ?? defaultEnvironment) !== env)
      return `Virtual datasource "${conn.id}" and its member ${id} must be in the same environment`;
    if (member.sshProfile) return `Virtual datasource "${conn.id}" cannot include ${id}: it is reached through an SSH profile`;
  }
  return null;
}

export const SeedConfigSchema = z
  .object({
    version: z.literal("1"),
    defaults: SeedDefaultsSchema.optional(),
    connections: z.array(SeedConnectionSchema).min(1, "At least one connection is required"),
    sshProfiles: z.array(SshProfileSchema).optional(),
    /** Freeze windows declared once (§4.17); read-only on the admin page. */
    freezeWindows: z.array(FreezeWindowSchema).optional(),
    /** Named roles declared once (§4.19); read-only on the admin page. */
    namedRoles: z.array(NamedRoleSchema).optional(),
    /** Runbooks declared once (§4.20); read-only on the admin page. */
    runbooks: z.array(RunbookSchema).optional(),
    /** Environments declared once (§4.36); relabelled or extended on the admin page. */
    environments: z.array(EnvironmentSchema).optional(),
    /** Notification channels declared once (§4.29); read-only on the admin page. */
    channels: z.array(ChannelSchema).optional(),
  })
  .refine((cfg) => new Set(cfg.connections.map((c) => c.id)).size === cfg.connections.length, {
    message: "Connection IDs must be unique",
  })
  .refine((cfg) => new Set((cfg.sshProfiles ?? []).map((p) => p.id)).size === (cfg.sshProfiles ?? []).length, {
    message: "SSH profile IDs must be unique",
  })
  .refine((cfg) => new Set((cfg.namedRoles ?? []).map((r) => r.id)).size === (cfg.namedRoles ?? []).length, {
    message: "Named role IDs must be unique",
  })
  .refine((cfg) => new Set((cfg.runbooks ?? []).map((r) => r.id)).size === (cfg.runbooks ?? []).length, {
    message: "Runbook IDs must be unique",
  })
  .refine((cfg) => new Set((cfg.channels ?? []).map((c) => c.id)).size === (cfg.channels ?? []).length, {
    message: "Channel IDs must be unique",
  })
  .superRefine((cfg, ctx) => {
    for (const conn of cfg.connections) {
      if (conn.type !== "virtual") continue;
      const problem = virtualMembersError(conn, cfg.connections, cfg.defaults?.environment);
      if (problem) ctx.addIssue({ code: "custom", message: problem, path: ["connections"] });
    }
  });

export type SeedConnection = z.infer<typeof SeedConnectionSchema>;
export type SeedDefaults = z.infer<typeof SeedDefaultsSchema>;
export type SeedConfig = z.infer<typeof SeedConfigSchema>;

export interface ManagedConnection extends DatabaseConnection {
  managed: boolean;
  roles: string[];
  writeRoles?: string[];
  writeApproval?: boolean;
  approverRoles?: string[];
  approvalsRequired?: number;
  guardrails?: boolean;
  limits?: DatasourceLimits;
  requireTicket?: boolean;
  exportRoles?: string[];
  sshProfile?: string;
  seedId: string;
  /** A virtual datasource's export rules are its members' (§4.44): every one must allow. */
  memberExportRules?: { environment?: string; exportRoles?: string[] }[];
  /** A virtual datasource's members, resolved for the person opening it (§4.44). */
  memberConnections?: ManagedConnection[];
}
