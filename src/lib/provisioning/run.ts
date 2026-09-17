/**
 * Provisioning the portal's own database account (docs/CONTEXT.md §4.54).
 *
 * Two entry points, one shape. `inspectAccount` opens the bootstrap connection, reads the
 * inventory and answers the plan with its blockers - what the admin sees before
 * confirming. `provisionAccount` does the same and then runs the plan statement by
 * statement, keeps the password where the deployment keeps secrets, and swaps the
 * datasource to it.
 *
 * The bootstrap credential is the datasource's own stored one - the application's, the one
 * in Vault today, which in the ordinary case owns the schema - unless the admin typed a
 * DBA's for this one call. Either way it is used through a provider built for this call
 * alone and disconnected at the end: it never enters the provider cache, the store, the
 * audit trail or a log line.
 *
 * Where the password goes decides what the datasource ends up holding:
 * - Vault configured: `<mount>/datasources/<id>` with the keys `user` and `password`
 *   (`agent_user`, `agent_password` beside them), and the datasource's fields become
 *   `vault:kv:` references, resolved when the connection opens. The mount is the one the
 *   datasource's own reference names when it has one, else the one the request names.
 * - No Vault: the password is stored on the datasource record, sealed at rest the way every
 *   stored credential is (`connection-secrets.ts`).
 * A datasource declared in the seed file cannot be rewritten here: its account is created
 * and its password stored, and the report carries the references to paste into the file.
 *
 * The run stops at the first refusal of a statement that is not optional and reports
 * every statement's outcome; a half-provisioned role is a fact the admin must see, and the
 * plan is re-runnable because every statement is idempotent under it (an existing role is
 * altered, a grant is repeated harmlessly).
 */

import { randomBytes } from "node:crypto";
import { emitAuditEvent } from "@/lib/audit";
import { listSharedDatasources, updateSharedDatasource } from "@/lib/datasources/store";
import { createDatabaseProvider, removeProvider, withOneShotTunnel } from "@/lib/db/factory";
import { applicationNameFor } from "@/lib/db/application-name";
import type { DatabaseProvider } from "@/lib/db/types";
import { getSeedConnectionByIdUnfiltered } from "@/lib/seed";
import { resolveEnvPlaceholders } from "@/lib/seed/credential-resolver";
import type { DatabaseConnection } from "@/lib/types";
import { isVaultConfigured, VaultError, writeKvSecret } from "@/lib/vault/client";
import {
  isVaultReference,
  parseVaultReference,
  resetVaultCache,
  resolveVaultReferences,
} from "@/lib/vault/credentials";
import { type ProvisionEngine, canProvisionAccount } from "./engines";
import { ProvisionError } from "./errors";
import { type InventoryRunner, readInventory } from "./inventory";
import { buildMysqlPlan, readMysqlInventory } from "./mysql";
import {
  buildPlan,
  type PlannedStatement,
  type ProvisionInventory,
  type ProvisionPlan,
  type ProvisionRequest,
} from "./plan";

/** The inventory read and the plan of each engine; the same shape, the engine's own rules. */
const ENGINES: Record<
  ProvisionEngine,
  {
    read: (runner: InventoryRunner, datasourceId: string, schemas: readonly string[]) => Promise<ProvisionInventory>;
    plan: typeof buildPlan;
  }
> = {
  postgres: { read: readInventory, plan: buildPlan },
  mysql: { read: readMysqlInventory, plan: buildMysqlPlan },
};

/** The one call's own credential, typed by the admin and never stored. */
export interface BootstrapCredential {
  readonly user: string;
  readonly password: string;
}

export interface InspectInput {
  readonly datasourceId: string;
  readonly request: ProvisionRequest;
  readonly bootstrap?: BootstrapCredential;
  /** The KV mount to write to when the datasource's own credential names none. */
  readonly vaultMount?: string;
  readonly actor: string;
}

/** Where the password will be kept, decided before anything runs so the admin sees it. */
export type SecretDestination =
  | { readonly kind: "vault"; readonly mount: string; readonly path: string }
  | { readonly kind: "store" }
  | { readonly kind: "seed-file"; readonly mount: string; readonly path: string };

export interface InspectReport {
  readonly inventory: ProvisionInventory;
  readonly plan: ProvisionPlan;
  readonly destination: SecretDestination;
}

export interface StatementOutcome {
  readonly shown: string;
  readonly purpose: string;
  readonly account: PlannedStatement["account"];
  readonly outcome: "ran" | "refused" | "skipped";
  /** The engine's own sentence when refused. */
  readonly error?: string;
}

export interface ProvisionReport {
  readonly roleName: string;
  readonly agentRoleName: string | null;
  readonly statements: readonly StatementOutcome[];
  /** Whether every non-optional statement ran; the password was stored only when true. */
  readonly completed: boolean;
  readonly destination: SecretDestination;
  /** The references a seed-file datasource has to be pointed at by hand. */
  readonly references?: {
    readonly user: string;
    readonly password: string;
    readonly agentUser?: string;
    readonly agentPassword?: string;
  };
}

const DEFAULT_MOUNT = "dbportal";
const PASSWORD_BYTES = 24;

/** A password of 32 URL-safe characters from 24 random bytes: no quote, no backslash, no space. */
export function generatePassword(): string {
  return randomBytes(PASSWORD_BYTES).toString("base64url");
}

/**
 * The datasource as declared and as resolved: the declaration still carries its `vault:`
 * references, which say where the deployment keeps this datasource's secrets; the
 * resolution carries the credential the portal holds, which opens the database.
 */
async function resolvedDatasource(
  datasourceId: string,
  actor: string,
): Promise<{ declared: DatabaseConnection; resolved: DatabaseConnection }> {
  const declared = await getSeedConnectionByIdUnfiltered(datasourceId);
  if (!declared) throw new ProvisionError(`Datasource "${datasourceId}" not found`, 404);
  if (!canProvisionAccount(declared.type)) {
    throw new ProvisionError("An account is provisioned on PostgreSQL and MySQL datasources only", 403);
  }
  try {
    return { declared, resolved: await resolveVaultReferences(resolveEnvPlaceholders(declared), actor) };
  } catch (error) {
    if (error instanceof VaultError)
      throw new ProvisionError(`The stored credential could not be read: ${error.message}`, 502);
    throw error;
  }
}

/** The mount the datasource's own reference names, when it has one. */
function mountOf(declared: DatabaseConnection): string | null {
  for (const field of ["password", "user"] as const) {
    const value = declared[field];
    if (isVaultReference(value)) {
      const ref = parseVaultReference(value);
      if (ref.kind === "kv") return ref.mount;
    }
  }
  return null;
}

async function destinationFor(
  datasourceId: string,
  declared: DatabaseConnection,
  requested?: string,
): Promise<SecretDestination> {
  const inStore = (await listSharedDatasources()).some((record) => record.id === datasourceId);
  if (!isVaultConfigured()) {
    if (!inStore) {
      throw new ProvisionError(
        "This datasource is declared in the seed file and Vault is not configured, so there is nowhere the portal could keep the new password. Configure VAULT_ADDR, or declare the datasource under Admin → Datasources.",
        409,
      );
    }
    return { kind: "store" };
  }
  const mount = mountOf(declared) ?? requested?.trim() ?? DEFAULT_MOUNT;
  if (!/^[A-Za-z0-9_\-.]+$/.test(mount)) throw new ProvisionError(`"${mount}" is not a Vault mount name`, 400);
  const path = `datasources/${datasourceId}`;
  return inStore ? { kind: "vault", mount, path } : { kind: "seed-file", mount, path };
}

/**
 * Run `work` against a provider built for this call alone: through the datasource's SSH
 * tunnel when it has one (the one-shot scope of #457, because nothing caches this
 * provider and nothing would ever close a pooled tunnel), connected here and
 * disconnected here whatever `work` does.
 */
async function withBootstrap<T>(
  declared: DatabaseConnection,
  bootstrap: BootstrapCredential | undefined,
  actor: string,
  work: (provider: DatabaseProvider) => Promise<T>,
): Promise<T> {
  const connection: DatabaseConnection = {
    ...declared,
    // A DBA's credential for this call, or the datasource's own.
    ...(bootstrap ? { user: bootstrap.user, password: bootstrap.password, connectionString: undefined } : {}),
    // Never the cached provider: `id` is what the cache is keyed by, and this connection
    // carries a credential the datasource's own pool must not inherit.
    id: `provision:${declared.id}:${Date.now()}`,
  };
  return withOneShotTunnel(connection, async (effective) => {
    const provider = await createDatabaseProvider(effective, { applicationName: applicationNameFor(actor) });
    try {
      await provider.connect();
    } catch (error) {
      throw new ProvisionError(
        `The bootstrap credential could not open the database: ${error instanceof Error ? error.message : String(error)}`,
        502,
      );
    }
    try {
      return await work(provider);
    } finally {
      await provider.disconnect();
    }
  });
}

async function inspectWith(
  provider: DatabaseProvider,
  engine: ProvisionEngine,
  input: InspectInput,
  secrets: { password: string; agentPassword: string },
) {
  const inventory = await ENGINES[engine].read(provider, input.datasourceId, input.request.schemas);
  return { inventory, plan: ENGINES[engine].plan(input.datasourceId, input.request, inventory, secrets) };
}

/** The engine of a datasource `resolvedDatasource` let through. */
function engineOf(declared: DatabaseConnection): ProvisionEngine {
  return declared.type as ProvisionEngine;
}

/** The plan and its blockers, without running anything. */
export async function inspectAccount(input: InspectInput): Promise<InspectReport> {
  const { declared, resolved } = await resolvedDatasource(input.datasourceId, input.actor);
  const destination = await destinationFor(input.datasourceId, declared, input.vaultMount);
  return withBootstrap(resolved, input.bootstrap, input.actor, async (provider) => {
    // Placeholder secrets: the shown plan masks them, and nothing runs here.
    const { inventory, plan } = await inspectWith(provider, engineOf(declared), input, {
      password: "x",
      agentPassword: "x",
    });
    return { inventory, plan, destination };
  });
}

/** Run the plan, keep the password, swap the datasource. */
export async function provisionAccount(input: InspectInput): Promise<ProvisionReport> {
  const { declared, resolved } = await resolvedDatasource(input.datasourceId, input.actor);
  const destination = await destinationFor(input.datasourceId, declared, input.vaultMount);
  const secrets = { password: generatePassword(), agentPassword: generatePassword() };
  const statements: StatementOutcome[] = [];
  let completed = true;
  let rotate = false;
  const plan = await withBootstrap(resolved, input.bootstrap, input.actor, async (provider) => {
    const inspected = await inspectWith(provider, engineOf(declared), input, secrets);
    rotate = inspected.inventory.roleExists;
    if (inspected.plan.blockers.length > 0) {
      throw new ProvisionError(`The plan cannot run yet: ${inspected.plan.blockers.join(" ")}`, 409);
    }
    for (const statement of inspected.plan.statements) {
      const base = { shown: statement.shown, purpose: statement.purpose, account: statement.account };
      if (!completed) {
        statements.push({ ...base, outcome: "skipped" });
        continue;
      }
      try {
        await provider.query(statement.sql);
        statements.push({ ...base, outcome: "ran" });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        statements.push({ ...base, outcome: "refused", error: message });
        if (!statement.optional) completed = false;
      }
    }
    return inspected.plan;
  });

  const audit = (result: "success" | "failure", details: string): void => {
    emitAuditEvent({
      type: "datasource_account",
      action: rotate ? "rotate" : "provision",
      target: input.datasourceId,
      connectionName: declared.name,
      user: input.actor,
      result,
      details,
    });
  };

  if (!completed) {
    const refused = statements.find((s) => s.outcome === "refused" && s.error !== undefined);
    audit("failure", `${input.request.profile}; stopped at: ${refused?.purpose ?? "unknown"}`);
    return {
      roleName: plan.roleName,
      agentRoleName: input.request.agent ? plan.agentRoleName : null,
      statements,
      completed,
      destination,
    };
  }

  const references = await keepSecret(input, plan, secrets, destination);
  audit(
    "success",
    `${input.request.profile}; schemas ${input.request.schemas.join(", ")}; ${input.request.agent ? "with" : "without"} agent account; password kept in ${destination.kind}`,
  );
  return {
    roleName: plan.roleName,
    agentRoleName: input.request.agent ? plan.agentRoleName : null,
    statements,
    completed,
    destination,
    ...(references ? { references } : {}),
  };
}

/** Keep the password where the deployment keeps secrets, and point the datasource at it. */
async function keepSecret(
  input: InspectInput,
  plan: ProvisionPlan,
  secrets: { password: string; agentPassword: string },
  destination: SecretDestination,
): Promise<ProvisionReport["references"] | undefined> {
  const agent = input.request.agent;
  if (destination.kind === "store") {
    await swapDatasource(input, {
      user: plan.roleName,
      password: secrets.password,
      ...(agent ? { agentUser: plan.agentRoleName, agentPassword: secrets.agentPassword } : {}),
    });
    return undefined;
  }

  const { mount, path } = destination;
  try {
    await writeKvSecret(mount, path, {
      user: plan.roleName,
      password: secrets.password,
      ...(agent ? { agent_user: plan.agentRoleName, agent_password: secrets.agentPassword } : {}),
    });
  } catch (error) {
    // The role exists and its password is known to nobody now: say so, in the report's
    // own words, rather than leaving a datasource that silently keeps the old credential.
    throw new ProvisionError(
      `The account was created but Vault refused the password (${error instanceof Error ? error.message : String(error)}). Run the plan again once the token may write ${mount}/data/${path}; the password will be rotated.`,
      502,
    );
  }
  // A cached copy of an older version of this secret must not outlive the write.
  resetVaultCache();
  const references = {
    user: `vault:kv:${mount}/${path}#user`,
    password: `vault:kv:${mount}/${path}#password`,
    ...(agent
      ? { agentUser: `vault:kv:${mount}/${path}#agent_user`, agentPassword: `vault:kv:${mount}/${path}#agent_password` }
      : {}),
  };
  if (destination.kind === "vault") {
    await swapDatasource(input, references);
    return undefined;
  }
  // Declared in the seed file: the account exists and the secret is kept, and the file is
  // the operator's to edit. The report carries what to paste.
  return references;
}

/** The datasource record updated to the account, and its cached pool dropped so the next open uses it. */
async function swapDatasource(
  input: InspectInput,
  credential: { user: string; password: string; agentUser?: string; agentPassword?: string },
): Promise<void> {
  const record = (await listSharedDatasources()).find((candidate) => candidate.id === input.datasourceId);
  // `destinationFor` established the record exists; a deletion in between is the one way here.
  if (!record)
    throw new ProvisionError(`Datasource "${input.datasourceId}" was deleted while its account was provisioned`, 409);
  await updateSharedDatasource(
    input.datasourceId,
    { ...record, ...credential, connectionString: undefined },
    input.actor,
  );
  await removeProvider(`seed:${input.datasourceId}`);
}
