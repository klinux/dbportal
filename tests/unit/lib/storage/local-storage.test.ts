import { describe, test, expect, beforeEach } from "bun:test";

if (typeof globalThis.window === "undefined") {
  // @ts-expect-error — minimal window stub
  globalThis.window = globalThis;
}

import {
  readJSON,
  writeJSON,
  readString,
  writeString,
  remove,
  getKey,
  migrateLegacyKey,
} from "@/lib/storage/local-storage";

describe("local-storage: getKey", () => {
  test("maps known collection names to dbportal_ prefix keys", () => {
    expect(getKey("connections")).toBe("dbportal_connections");
    expect(getKey("history")).toBe("dbportal_history");
    expect(getKey("saved_queries")).toBe("dbportal_saved_queries");
    expect(getKey("audit_log")).toBe("dbportal_audit_log");
    expect(getKey("masking_config")).toBe("dbportal_masking_config");
    expect(getKey("threshold_config")).toBe("dbportal_threshold_config");
  });

  test("falls back to dbportal_ prefix for unknown collections", () => {
    expect(getKey("unknown")).toBe("dbportal_unknown");
  });
});

describe("local-storage: readJSON / writeJSON", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test("writeJSON / readJSON round-trip", () => {
    writeJSON("connections", [{ id: 1 }]);
    expect(readJSON<{ id: number }[]>("connections")).toEqual([{ id: 1 }]);
  });

  test("readJSON returns null for non-existent key", () => {
    expect(readJSON("nonexistent")).toBeNull();
  });

  test("readJSON returns null for invalid JSON", () => {
    localStorage.setItem("dbportal_connections", "not-json{{{");
    expect(readJSON("connections")).toBeNull();
  });
});

describe("local-storage: readString / writeString", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test("writeString / readString round-trip", () => {
    writeString("active_connection_id", "conn-42");
    expect(readString("active_connection_id")).toBe("conn-42");
  });

  test("readString returns null for non-existent key", () => {
    expect(readString("active_connection_id")).toBeNull();
  });
});

describe("local-storage: writeJSON quota handling", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test("returns true on success", () => {
    const result = writeJSON("test-key", { data: "value" });
    expect(result).toBe(true);
  });

  test("returns false on QuotaExceededError", () => {
    const originalSetItem = localStorage.setItem;
    localStorage.setItem = () => {
      throw new DOMException("quota exceeded", "QuotaExceededError");
    };
    try {
      const result = writeJSON("test-key", { data: "value" });
      expect(result).toBe(false);
    } finally {
      localStorage.setItem = originalSetItem;
    }
  });
});

describe("local-storage: writeString quota handling", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test("returns true on success", () => {
    const result = writeString("active_connection_id", "conn-42");
    expect(result).toBe(true);
  });

  test("returns false on QuotaExceededError", () => {
    const originalSetItem = localStorage.setItem;
    localStorage.setItem = () => {
      throw new DOMException("quota exceeded", "QuotaExceededError");
    };
    try {
      const result = writeString("active_connection_id", "conn-42");
      expect(result).toBe(false);
    } finally {
      localStorage.setItem = originalSetItem;
    }
  });
});

describe("local-storage: remove", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test("remove deletes the key", () => {
    writeString("active_connection_id", "conn-42");
    remove("active_connection_id");
    expect(readString("active_connection_id")).toBeNull();
  });
});

// docs/CONTEXT.md §5, layer 3: a browser that used the snapshot keeps its data - the old
// key is moved to the new name on first read, and never consulted again.
describe("local-storage: legacy key migration", () => {
  test("a value under libredb_ moves to dbportal_ on the first read, and a new value is never overwritten", () => {
    localStorage.clear();
    localStorage.setItem("libredb_history", JSON.stringify([{ id: "h1" }]));
    expect(readJSON<unknown>("history")).toEqual([{ id: "h1" }]);
    expect(localStorage.getItem("dbportal_history")).not.toBeNull();
    expect(localStorage.getItem("libredb_history")).toBeNull();

    localStorage.setItem("dbportal_active_connection_id", "new");
    localStorage.setItem("libredb_active_connection_id", "old");
    expect(readString("active_connection_id")).toBe("new");
    expect(localStorage.getItem("libredb_active_connection_id")).toBe("old");
    migrateLegacyKey("unprefixed");
    localStorage.clear();
  });
});
