/**
 * What an Athena connection means, read off the shared connection record once.
 *
 * The shared `DatabaseConnection` has no AWS-shaped fields of its own, so this
 * provider reads its settings out of the fields that exist - `user` and `password`
 * carry the access key pair, `database` the Athena database, `region`,
 * `workgroup` and `outputLocation` are the three the record gained for it - and
 * refuses, HERE and before any request is made, every spelling the service would
 * refuse later with a less useful sentence. No I/O and no SDK import: the transport
 * takes the resolved settings and trusts them, and the provider's `validate()`
 * reports a refusal as a configuration error.
 */

import type { DatabaseConnection } from "@/lib/db/types";
import { ATHENA_DEFAULT_CATALOG, ATHENA_DEFAULT_WORKGROUP } from "./transport";

/** The static key pair a connection carries, or nothing, in which case the runtime's own chain is used. */
export interface AthenaStaticCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

export interface AthenaSettings {
  readonly region: string;
  readonly catalog: string;
  /** The Athena database unqualified names resolve against, or undefined for none. */
  readonly database: string | undefined;
  readonly workgroup: string;
  /** The S3 prefix results are written to, with its trailing slash, or undefined to rely on the workgroup's. */
  readonly outputLocation: string | undefined;
  readonly credentials: AthenaStaticCredentials | undefined;
}

/** A setting the service would refuse, reported before it is sent. */
export class AthenaSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AthenaSettingsError";
    Object.setPrototypeOf(this, AthenaSettingsError.prototype);
  }
}

/**
 * The shape of every AWS region code: a two-letter partition prefix, one or more
 * words, and a number - `us-east-1`, `eu-central-1`, `ap-southeast-2`,
 * `us-gov-west-1`, `cn-north-1`. Anything else is a typo the SDK would otherwise
 * turn into a DNS lookup for `athena.<typo>.amazonaws.com` and report as an
 * unreachable host.
 */
const REGION = /^[a-z]{2}(?:-[a-z]+)+-\d+$/;

/** The service's own constraint on a workgroup name. */
const WORKGROUP = /^[a-zA-Z0-9._-]{1,128}$/;

/**
 * An S3 URI whose bucket obeys the bucket naming rules: 3 to 63 characters of
 * lowercase letters, digits, dots and hyphens, starting and ending with a letter
 * or digit. The path is free-form.
 */
const OUTPUT_LOCATION = /^s3:\/\/[a-z0-9](?:[a-z0-9.-]{1,61}[a-z0-9])?(?:\/.*)?$/;

/**
 * The prefix of a TEMPORARY access key id.
 *
 * Such a key is only valid together with the session token it was issued with,
 * and the connection record has no field for one. Refused by name rather than
 * sent, because the service's answer to a temporary key without its token is
 * "The security token included in the request is invalid" - a sentence about a
 * token the user never typed.
 */
const TEMPORARY_KEY_PREFIX = "ASIA";

/** A field's text, or undefined for absent and for blank. */
function text(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}

/**
 * The credentials a connection carries, or undefined when it carries none.
 *
 * Both halves or neither: one half alone is a record that was half filled in,
 * and sending it would fail as an invalid signature, which points the user at
 * the wrong half.
 */
function readCredentials(config: DatabaseConnection): AthenaStaticCredentials | undefined {
  const accessKeyId = text(config.user);
  const secretAccessKey = text(config.password);
  if (accessKeyId === undefined && secretAccessKey === undefined) return undefined;
  if (accessKeyId === undefined || secretAccessKey === undefined) {
    throw new AthenaSettingsError(
      "Athena needs both halves of an access key pair - the access key id as the user and the secret access key as the password - or neither, to use the credentials the runtime itself carries.",
    );
  }
  if (accessKeyId.startsWith(TEMPORARY_KEY_PREFIX)) {
    throw new AthenaSettingsError(
      `Access key ids starting with ${TEMPORARY_KEY_PREFIX} are temporary and only valid with the session token they were issued with, which this connection has no field for. Use a long-term key (one starting with AKIA), or leave both fields empty to use the credentials the runtime carries.`,
    );
  }
  return { accessKeyId, secretAccessKey };
}

/** The settings, or a refusal naming the field and what would be accepted. */
export function readAthenaSettings(config: DatabaseConnection): AthenaSettings {
  const region = text(config.region);
  if (region === undefined) {
    throw new AthenaSettingsError("Athena requires an AWS region, such as us-east-1");
  }
  if (!REGION.test(region)) {
    throw new AthenaSettingsError(
      `"${region}" is not an AWS region code; expected a form like us-east-1 or eu-central-1`,
    );
  }

  const workgroup = text(config.workgroup) ?? ATHENA_DEFAULT_WORKGROUP;
  if (!WORKGROUP.test(workgroup)) {
    throw new AthenaSettingsError(
      `"${workgroup}" is not a workgroup name; the service accepts 1 to 128 letters, digits, dots, underscores and hyphens`,
    );
  }

  const location = text(config.outputLocation);
  if (location !== undefined && !OUTPUT_LOCATION.test(location)) {
    throw new AthenaSettingsError(
      `"${location}" is not an S3 location; expected s3://<bucket>/<prefix>/ with a bucket name of 3 to 63 lowercase letters, digits, dots and hyphens`,
    );
  }

  return {
    region,
    catalog: ATHENA_DEFAULT_CATALOG,
    database: text(config.database),
    workgroup,
    // The service writes `<location><query id>.csv`, so a prefix without its slash
    // would fuse the id onto the last path segment.
    outputLocation: location === undefined || location.endsWith("/") ? location : `${location}/`,
    credentials: readCredentials(config),
  };
}
