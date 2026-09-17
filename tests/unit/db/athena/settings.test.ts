/**
 * Athena connection settings
 *
 * The provider reads its settings off the shared connection record once, and every
 * spelling the service would refuse later - with a sentence about the wrong thing -
 * is refused here first, naming the field. Each refusal below is one such sentence
 * the user would otherwise have met: a typo in the region becomes a DNS failure for
 * `athena.<typo>.amazonaws.com`, a temporary key without its token becomes "the
 * security token included in the request is invalid", and half a key pair becomes an
 * invalid signature.
 */
import { describe, expect, test } from "bun:test";
import { AthenaSettingsError, readAthenaSettings } from "@/lib/db/providers/sql/athena/settings";
import { ATHENA_DEFAULT_CATALOG, ATHENA_DEFAULT_WORKGROUP } from "@/lib/db/providers/sql/athena/transport";
import type { DatabaseConnection } from "@/lib/db/types";

function makeConnection(overrides: Partial<DatabaseConnection> = {}): DatabaseConnection {
  return {
    id: "athena-1",
    name: "Lake",
    type: "athena",
    region: "us-east-1",
    createdAt: new Date("2026-09-17T00:00:00.000Z"),
    ...overrides,
  };
}

describe("readAthenaSettings", () => {
  test("reads the region, the default catalog and the default workgroup off a minimal connection", () => {
    expect(readAthenaSettings(makeConnection())).toEqual({
      region: "us-east-1",
      catalog: ATHENA_DEFAULT_CATALOG,
      database: undefined,
      workgroup: ATHENA_DEFAULT_WORKGROUP,
      outputLocation: undefined,
      credentials: undefined,
    });
  });

  test("carries the database, the workgroup, the result location and the key pair when given", () => {
    const settings = readAthenaSettings(
      makeConnection({
        database: "analytics",
        workgroup: "reporting",
        outputLocation: "s3://lake-results/athena/",
        user: "AKIAEXAMPLEEXAMPLE01",
        password: "secret",
      }),
    );

    expect(settings.database).toBe("analytics");
    expect(settings.workgroup).toBe("reporting");
    expect(settings.outputLocation).toBe("s3://lake-results/athena/");
    expect(settings.credentials).toEqual({ accessKeyId: "AKIAEXAMPLEEXAMPLE01", secretAccessKey: "secret" });
  });

  // The service writes `<location><query id>.csv`, so a prefix without its slash would
  // fuse the id onto the last path segment: `s3://b/athena` + id becomes `s3://b/athenaXYZ`.
  test("appends the slash a result location was written without", () => {
    expect(readAthenaSettings(makeConnection({ outputLocation: "s3://lake-results/athena" })).outputLocation).toBe(
      "s3://lake-results/athena/",
    );
    expect(readAthenaSettings(makeConnection({ outputLocation: "s3://lake-results" })).outputLocation).toBe(
      "s3://lake-results/",
    );
  });

  test("trims every field and reads a blank one as absent", () => {
    const settings = readAthenaSettings(
      makeConnection({
        region: " eu-central-1 ",
        database: "  ",
        workgroup: "",
        outputLocation: " ",
        user: "",
        password: " ",
      }),
    );

    expect(settings.region).toBe("eu-central-1");
    expect(settings.database).toBeUndefined();
    expect(settings.workgroup).toBe(ATHENA_DEFAULT_WORKGROUP);
    expect(settings.outputLocation).toBeUndefined();
    expect(settings.credentials).toBeUndefined();
  });

  test("requires a region, because the service has no host to derive one from", () => {
    expect(() => readAthenaSettings(makeConnection({ region: undefined }))).toThrow(AthenaSettingsError);
    expect(() => readAthenaSettings(makeConnection({ region: "" }))).toThrow(/requires an AWS region/);
  });

  test.each(["us-east-1", "us-gov-west-1", "ap-southeast-2", "cn-north-1", "eu-central-1", "il-central-1"])(
    "accepts the region code %s",
    (region) => {
      expect(readAthenaSettings(makeConnection({ region })).region).toBe(region);
    },
  );

  test.each(["useast1", "us-east", "US-EAST-1", "athena.us-east-1.amazonaws.com", "us_east_1", "1-us-east"])(
    "refuses %s as a region code rather than resolving a host nothing answers at",
    (region) => {
      expect(() => readAthenaSettings(makeConnection({ region }))).toThrow(/not an AWS region code/);
    },
  );

  test("refuses a workgroup name the service would refuse", () => {
    expect(() => readAthenaSettings(makeConnection({ workgroup: "reporting team" }))).toThrow(/not a workgroup name/);
    expect(() => readAthenaSettings(makeConnection({ workgroup: "a".repeat(129) }))).toThrow(AthenaSettingsError);
  });

  test.each([
    "lake-results/athena/",
    "s3:/lake-results/",
    "s3://Lake-Results/",
    "s3://ab/",
    "s3://-lake/",
    "s3://lake_results/",
    "https://lake-results.s3.amazonaws.com/",
  ])("refuses %s as a result location", (outputLocation) => {
    expect(() => readAthenaSettings(makeConnection({ outputLocation }))).toThrow(/not an S3 location/);
  });

  test("refuses half a key pair, naming which half is missing from the user's point of view", () => {
    expect(() => readAthenaSettings(makeConnection({ user: "AKIAEXAMPLEEXAMPLE01" }))).toThrow(/both halves/);
    expect(() => readAthenaSettings(makeConnection({ password: "secret" }))).toThrow(/both halves/);
  });

  // A temporary key is only valid with the session token it was issued with, and the
  // record has no field for one; the service's own answer would be about a token the
  // user never typed.
  test("refuses a temporary access key, which needs a session token the connection cannot carry", () => {
    expect(() => readAthenaSettings(makeConnection({ user: "ASIAEXAMPLEEXAMPLE01", password: "secret" }))).toThrow(
      /temporary/,
    );
  });

  test("the refusal is its own error class, so the provider can tell it from a bug", () => {
    const error = new AthenaSettingsError("x");

    expect(error).toBeInstanceOf(AthenaSettingsError);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("AthenaSettingsError");
  });
});
