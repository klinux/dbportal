"use client";

import type { ReactNode } from "react";

import { Sheet, SheetContent, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { CONFIG_SHEET_CLASS } from "@/lib/ui/config-sheet";
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle, DrawerDescription } from "@/components/ui/drawer";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  DatabaseConnection,
  ConnectionEnvironment,
  ENVIRONMENT_COLORS,
  ENVIRONMENT_LABELS,
  SSLMode,
} from "@/lib/types";
import {
  Database,
  ShieldCheck,
  Zap,
  Globe,
  Key,
  Link,
  CircleCheck,
  CircleX,
  TriangleAlert,
  ClipboardPaste,
  Lock,
  ChevronDown,
  Terminal,
  Settings2,
  Server,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { DatabaseType } from "@/lib/types";
import { getDBConfig, isFileBased, takesConnectionField } from "@/lib/db-ui-config";
import { motion, AnimatePresence } from "framer-motion";
import { useConnectionForm } from "@/hooks/use-connection-form";
import { useIsMobile } from "@/hooks/use-mobile";
import { WireCompatibilityHint } from "@/components/WireCompatibilityHint";

/**
 * What each SSL mode actually does, in the panel where it is chosen.
 *
 * `verify-system` is the one that needs the sentence most (D26): without it a reader cannot
 * tell it from `verify-ca` and goes looking for a CA file that mode does not want. The
 * SSLMode union is published (src/lib/types.ts), so this Record is exhaustive by type - a
 * mode added there without copy here fails typecheck rather than rendering an empty hint.
 */
const SSL_MODE_HINTS: Record<SSLMode, string> = {
  disable: "Plaintext. Nothing is encrypted.",
  require: "Encrypts but verifies nothing - any certificate is accepted, including a forged one.",
  "verify-system":
    "Encrypts and verifies the certificate chain and host name against the system trust store - no certificate to paste. Use this for a managed endpoint (Neon, Supabase, Atlas, RDS, Capella).",
  "verify-ca": "Encrypts and verifies the chain against the CA certificate below. Paste one for a private CA.",
  "verify-full":
    "Encrypts and verifies the chain against the CA certificate below, and that it names the host you typed.",
};

interface ConnectionModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConnect: (conn: DatabaseConnection) => void;
  editConnection?: DatabaseConnection | null;
  /** Optional API adapter: when provided, bypasses the built-in /api/db/test-connection fetch. */
  onTestConnection?: (
    connection: DatabaseConnection,
  ) => Promise<{ success: boolean; latency?: number; error?: string }>;
  /**
   * What the dialog is for, when it is not the studio's own connection editor. The admin
   * datasource page reuses this form (docs/CONTEXT.md §4.1 step B) and says so in the
   * heading and on the button; the fields and the test-before-save flow stay the same.
   */
  heading?: { title: string; description: string };
  submitLabel?: string;
  /** The SSH profiles a datasource may be reached through (docs/CONTEXT.md §4.9); absent where none apply. */
  sshProfiles?: { id: string; name: string; host: string; username: string }[];
  /** Rendered above the connection fields: the caller's own inputs (roles, notes) that travel with the save. */
  extraFields?: ReactNode;
}

export function ConnectionModal({
  isOpen,
  onClose,
  onConnect,
  editConnection,
  onTestConnection,
  heading,
  submitLabel,
  sshProfiles,
  extraFields,
}: ConnectionModalProps) {
  const isMobile = useIsMobile();
  const {
    // Connection fields
    type,
    setType,
    name,
    setName,
    host,
    setHost,
    port,
    setPort,
    user,
    setUser,
    password,
    setPassword,
    database,
    setDatabase,
    schema,
    setSchema,
    queryTimeout,
    setQueryTimeout,
    skipObjectScan,
    setSkipObjectScan,
    connectionString,
    setConnectionString,
    mongoConnectionMode,
    setMongoConnectionMode,
    environment,
    setEnvironment,

    // UI state
    isTesting,
    testResult,
    setTestResult,
    pasteInput,
    setPasteInput,
    showPasteInput,
    setShowPasteInput,
    isEditMode,

    // SSL/TLS
    showSSL,
    setShowSSL,
    sslMode,
    setSSLMode,
    caCert,
    setCaCert,
    clientCert,
    setClientCert,
    clientKey,
    setClientKey,

    // Advanced (Oracle/MSSQL)
    showAdvanced,
    setShowAdvanced,
    serviceName,
    setServiceName,
    instanceName,
    setInstanceName,
    localDataCenter,
    setLocalDataCenter,
    authSource,
    setAuthSource,

    // SSH (docs/CONTEXT.md §4.9): the profile reference, nothing typed per datasource
    sshProfile,
    setSshProfile,

    // Handlers
    handleTestConnection,
    handleConnect,
    handlePasteConnectionString,

    // Derived data
    dbTypes,
  } = useConnectionForm({ isOpen, onClose, onConnect, editConnection, onTestConnection, submitLabel });

  const title = heading?.title ?? (isEditMode ? "Edit Connection" : "New Connection");
  const description =
    heading?.description ??
    (isEditMode
      ? "Update your database connection parameters."
      : "Configure your database connection parameters securely.");
  const submitText = submitLabel ?? (isEditMode ? "Save Changes" : "Establish Connection");

  // Couchbase pins one bucket per connection (issue #262, decision 4), so the shared
  // `database` field holds a bucket name and the form must say so.
  const isCouchbase = type === "couchbase";
  // Trino pins one CATALOG the same way (issue #424 Phase 2). "Database" would be the
  // wrong word twice over: a Trino catalog is a whole external system (`hive`,
  // `iceberg`, `tpch`), and the field is the one thing a user cannot guess - a
  // coordinator with no catalog selected resolves no table at all.
  const isTrino = type === "trino";
  // Cassandra pins one KEYSPACE the same way (issue #424 Phase 4). "Database" is the
  // wrong word here too: a keyspace carries the replication settings, not just a
  // namespace, and without one pinned an unqualified table name resolves to nothing
  // at all - measured on 5.0.9, "No keyspace has been specified. USE a keyspace, or
  // explicitly specify keyspace.tablename".
  const isCassandra = type === "cassandra";
  // MongoDB keeps its users in a database of their own, and the driver checks the
  // credentials against whichever database the URI names when nothing says otherwise.
  // So the ordinary deployment - users in `admin`, data elsewhere - had no way through
  // the discrete fields at all, and failed as a credentials error.
  const isMongoDB = type === "mongodb";
  // libSQL has no user names at all: the credential a server checks is a TOKEN it
  // minted (Turso prints one per database), so the shared `password` field holds a
  // JWT here. A field labelled Password invites a password no libSQL server has,
  // which is why this one is relabelled rather than left to be guessed at.
  const isLibSQL = type === "libsql";
  const passwordFieldLabel = isLibSQL ? "Auth Token" : "Password";
  const databaseFieldLabel = isCouchbase ? "Bucket" : isTrino ? "Catalog" : isCassandra ? "Keyspace" : "Database";
  const databaseFieldPlaceholder = isTrino ? "tpch" : isCassandra ? "probe" : "db";
  const connectionUriPlaceholder = isCouchbase
    ? "couchbase://localhost:8091/travel-sample  or  couchbases://cb.<id>.cloud.couchbase.com/..."
    : isLibSQL
      ? "libsql://<database>-<org>.turso.io?authToken=<jwt>"
      : "mongodb://localhost:27017/mydb  or  mongodb+srv://...";

  const formContent = (
    <>
      {/* Progress bar — fixed top */}
      <div className="shrink-0 h-2 w-full bg-brand-solid/20">
        <motion.div
          initial={{ width: 0 }}
          animate={{ width: "100%" }}
          className="h-full bg-brand-tint shadow-[0_0_15px_rgba(59,130,246,0.5)]"
        />
      </div>

      {/* Scrollable body */}
      <div className="flex-1 overflow-y-auto p-4 md:p-8">
        <div className="mb-4 md:mb-8">
          <div className="flex items-center gap-3 mb-2">
            <div className="p-2 rounded-xl bg-brand-tint/10 border border-brand-tint/20">
              <Zap strokeWidth={1.5} className="w-5 h-5 text-brand" />
            </div>
            <h2 className="text-xs md:text-[0.8125rem] font-medium">{title}</h2>
          </div>
          <div className="flex items-center justify-between">
            <p className="text-xs text-fg-muted">{description}</p>
            {!isEditMode && (
              <button
                onClick={() => setShowPasteInput(!showPasteInput)}
                className="flex items-center gap-1.5 text-xs font-mediumr text-brand hover:text-brand-bright transition-colors px-2 py-1 rounded-md hover:bg-brand-tint/10"
              >
                <ClipboardPaste strokeWidth={1.5} className="w-3 h-3" />
                Paste URL
              </button>
            )}
          </div>
        </div>

        {extraFields}

        {/* Paste Connection String Input */}
        <AnimatePresence>
          {showPasteInput && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className="mb-6 overflow-hidden"
            >
              <div className="p-3 rounded-lg border border-brand-tint/20 bg-brand-tint/5 space-y-2">
                <Label className="text-xs font-mediumr text-brand">Paste Connection URL</Label>
                <div className="flex gap-2">
                  <Input
                    value={pasteInput}
                    onChange={(e) => setPasteInput(e.target.value)}
                    placeholder="postgres://user:pass@host:5432/db  or  mongodb://..."
                    className="h-9 bg-panel border-hairline focus:border-brand-tint/50 text-xs font-mono flex-1"
                    onKeyDown={(e) => e.key === "Enter" && handlePasteConnectionString()}
                  />
                  <Button
                    size="sm"
                    onClick={handlePasteConnectionString}
                    className="bg-brand-solid hover:bg-brand-solid-hover text-white h-9 px-4 text-xs font-medium"
                  >
                    Parse
                  </Button>
                </div>
                <p className="text-xs text-fg-muted">
                  Supports: postgres://, mysql://, mongodb://, redis://, oracle://, mssql://
                </p>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <div className="space-y-4 md:space-y-6">
          {/* Connection Name - always visible */}
          <div className="space-y-2">
            <div className="flex items-center gap-2 mb-1">
              <Database strokeWidth={1.5} className="w-3 h-3 text-fg-muted" />
              <Label htmlFor="name" className="text-xs font-mediumr text-fg-muted">
                Connection Name
              </Label>
            </div>
            <Input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My Database"
              className="h-10 bg-panel border-hairline focus:border-brand-tint/50 transition-all text-xs"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="queryTimeout" className="text-xs font-mediumr text-fg-muted">
              Query Timeout (ms)
            </Label>
            <Input
              id="queryTimeout"
              type="number"
              min={1}
              max={2147483647}
              step={1}
              value={queryTimeout}
              onChange={(e) => setQueryTimeout(e.target.value)}
              placeholder="60000"
              aria-describedby="queryTimeout-hint"
              className="h-10 bg-panel border-hairline focus:border-brand-tint/50 transition-all text-xs"
            />
            <p id="queryTimeout-hint" className="text-xs text-fg-muted">
              Leave blank to use the default of 60 seconds.
            </p>
          </div>

          {/*
            The no-scan escape hatch (#765). Beside the timeout rather than behind the
            Advanced accordion, and not gated on the engine: every engine has a catalog,
            and the connection that holds tens of thousands of objects is the one that
            knows it does.
          */}
          <div className="space-y-2">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                id="skipObjectScan"
                type="checkbox"
                checked={skipObjectScan}
                onChange={(e) => setSkipObjectScan(e.target.checked)}
                aria-describedby="skipObjectScan-hint"
                className="rounded border-edge bg-panel"
              />
              <span className="text-xs font-mediumr text-fg-muted">Do not read the object list on connect</span>
            </label>
            <p id="skipObjectScan-hint" className="text-xs text-fg-muted">
              The editor still works. The object panel offers a load action instead.
            </p>
          </div>

          {/* Environment Selector */}
          <div className="space-y-2">
            <Label className="text-xs font-mediumr text-fg-muted">Environment</Label>
            <div className="flex flex-wrap items-center gap-2">
              {(Object.keys(ENVIRONMENT_COLORS) as ConnectionEnvironment[]).map((env) => (
                <button
                  key={env}
                  onClick={() => setEnvironment(env)}
                  className={cn(
                    "flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-mediumr transition-all border",
                    environment === env
                      ? "border-edge bg-fill text-fg"
                      : "border-transparent text-fg-muted hover:text-fg-secondary hover:bg-fill",
                  )}
                >
                  <div className="w-2 h-2 rounded-full" style={{ backgroundColor: ENVIRONMENT_COLORS[env] }} />
                  {env === "other" ? "Other" : ENVIRONMENT_LABELS[env]}
                </button>
              ))}
            </div>
          </div>

          {/* DB type: one row, not seventeen cards - the sheet is 50% of the viewport and the
              form below it is what the person came for. Disabled in edit mode: the engine of a
              saved datasource cannot change, only its settings. */}
          <div className="space-y-1.5">
            <Label htmlFor="db-type" className="text-xs text-fg-tertiary">
              Database type
            </Label>
            <Select
              value={type}
              disabled={isEditMode}
              onValueChange={(value) => {
                const next = value as DatabaseType;
                setType(next);
                const cfg = getDBConfig(next);
                if (cfg.defaultPort) setPort(cfg.defaultPort);
                setTestResult(null);
              }}
            >
              <SelectTrigger
                id="db-type"
                aria-label="Database type"
                className="h-10 w-full bg-panel border-hairline-strong"
              >
                <SelectValue placeholder="Choose a database" />
              </SelectTrigger>
              <SelectContent>
                {dbTypes.map((db) => (
                  <SelectItem key={db.value} value={db.value}>
                    <db.icon className={cn("w-4 h-4", db.color)} />
                    <span>{db.label}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Wire-compatible engines served by the selected driver (#424) */}
          <WireCompatibilityHint type={type} />

          <div className="space-y-4 animate-in fade-in slide-in-from-bottom-4 duration-500">
            <>
              {/* Connection string mode toggle */}
              {getDBConfig(type).showConnectionStringToggle && (
                <div className="flex items-center gap-2 p-1 rounded-lg bg-panel border border-hairline">
                  <button
                    onClick={() => setMongoConnectionMode("host")}
                    className={cn(
                      "flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-md text-xs font-medium transition-all",
                      mongoConnectionMode === "host"
                        ? "bg-brand-solid/20 text-brand border border-brand-tint/30"
                        : "text-fg-muted hover:text-fg-secondary",
                    )}
                  >
                    <Globe strokeWidth={1.5} className="w-3 h-3" />
                    Host / Port
                  </button>
                  <button
                    onClick={() => setMongoConnectionMode("connectionString")}
                    className={cn(
                      "flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-md text-xs font-medium transition-all",
                      mongoConnectionMode === "connectionString"
                        ? "bg-brand-solid/20 text-brand border border-brand-tint/30"
                        : "text-fg-muted hover:text-fg-secondary",
                    )}
                  >
                    <Link strokeWidth={1.5} className="w-3 h-3" />
                    Connection String
                  </button>
                </div>
              )}

              {getDBConfig(type).showConnectionStringToggle && mongoConnectionMode === "connectionString" ? (
                <>
                  <div className="space-y-2">
                    <div className="flex items-center gap-2 mb-1">
                      <Link strokeWidth={1.5} className="w-3 h-3 text-fg-muted" />
                      <Label htmlFor="connectionString" className="text-xs font-mediumr text-fg-muted">
                        Connection URI
                      </Label>
                    </div>
                    <Input
                      id="connectionString"
                      value={connectionString}
                      onChange={(e) => setConnectionString(e.target.value)}
                      placeholder={connectionUriPlaceholder}
                      className="h-10 bg-panel border-hairline focus:border-brand-tint/50 transition-all text-xs font-mono"
                    />
                  </div>
                  <div className="space-y-2">
                    <div className="flex items-center gap-2 mb-1">
                      <Database strokeWidth={1.5} className="w-3 h-3 text-fg-muted" />
                      <Label htmlFor="database" className="text-xs font-mediumr text-fg-muted">
                        {databaseFieldLabel} Name (optional override)
                      </Label>
                    </div>
                    <Input
                      id="database"
                      value={database}
                      onChange={(e) => setDatabase(e.target.value)}
                      placeholder="Extracted from URI if not provided"
                      className="h-10 bg-panel border-hairline focus:border-brand-tint/50 transition-all text-xs font-mono"
                    />
                  </div>
                </>
              ) : isFileBased(type) ? (
                <div className="space-y-2">
                  <div className="flex items-center gap-2 mb-1">
                    <Database strokeWidth={1.5} className="w-3 h-3 text-fg-muted" />
                    <Label htmlFor="database" className="text-xs font-medium text-fg-muted">
                      Database File Path
                    </Label>
                  </div>
                  <Input
                    id="database"
                    value={database}
                    onChange={(e) => setDatabase(e.target.value)}
                    placeholder="/path/to/database file"
                    className="h-10 bg-panel border-hairline focus:border-brand-tint/50 transition-all text-xs font-mono"
                  />
                </div>
              ) : (
                <>
                  <div className="space-y-2">
                    <div className="flex items-center gap-2 mb-1">
                      <Globe strokeWidth={1.5} className="w-3 h-3 text-fg-muted" />
                      <Label htmlFor="host" className="text-xs font-mediumr text-fg-muted">
                        Host & Instance
                      </Label>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                      <Input
                        id="host"
                        value={host}
                        onChange={(e) => setHost(e.target.value)}
                        placeholder="localhost"
                        autoComplete="off"
                        className="md:col-span-3 h-10 bg-panel border-hairline focus:border-brand-tint/50 transition-all text-xs"
                      />
                      <Input
                        id="port"
                        value={port}
                        onChange={(e) => setPort(e.target.value)}
                        autoComplete="off"
                        className="h-10 bg-panel border-hairline focus:border-brand-tint/50 transition-all text-xs font-mono"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {/*
                      Only when the engine takes it. libSQL authenticates with a token the
                      server minted and has no user names at all, so a Username box there
                      collected a value `buildConnection` then discarded.
                    */}
                    {takesConnectionField(type, "user") && (
                      <div className="space-y-2">
                        <div className="flex items-center gap-2 mb-1">
                          <Key strokeWidth={1.5} className="w-3 h-3 text-fg-muted" />
                          <Label htmlFor="user" className="text-xs font-mediumr text-fg-muted">
                            Username
                          </Label>
                        </div>
                        <Input
                          id="user"
                          value={user}
                          onChange={(e) => setUser(e.target.value)}
                          placeholder="user"
                          autoComplete="off"
                          className="h-10 bg-panel border-hairline focus:border-brand-tint/50 transition-all text-xs"
                        />
                      </div>
                    )}
                    <div className={takesConnectionField(type, "user") ? "space-y-2" : "space-y-2 md:col-span-2"}>
                      <div className="flex items-center gap-2 mb-1">
                        <ShieldCheck strokeWidth={1.5} className="w-3 h-3 text-fg-muted" />
                        <Label htmlFor="password" className="text-xs font-mediumr text-fg-muted">
                          {passwordFieldLabel}
                        </Label>
                      </div>
                      <Input
                        id="password"
                        type="password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        placeholder="***"
                        // Server credential, not the user's own login: "new-password" is the only
                        // value Chrome honours to keep saved site passwords out of the field.
                        autoComplete="new-password"
                        className="h-10 bg-panel border-hairline focus:border-brand-tint/50 transition-all text-xs"
                      />
                      {/*
                        Measured on Trino 476 with authentication DISABLED: a request
                        carrying `Authorization: Basic` over plain HTTP is answered 401,
                        "Password not allowed for insecure authentication". So a
                        password is a TLS-only credential here, and typing one into an
                        http:// connection BREAKS a connection that would otherwise
                        work. The provider refuses the combination outright; this says
                        so before the user reaches that error.
                      */}
                      {isLibSQL && (
                        <p className="text-xs text-fg-muted">
                          Turso Cloud mints this per database (`turso db tokens create`). A self-hosted libSQL server
                          started without authentication takes none - leave it empty.
                        </p>
                      )}
                      {isTrino && (
                        <p className="text-xs text-fg-muted">
                          Trino refuses a password over plain HTTP. Enable TLS below, or leave this empty to connect as
                          an unauthenticated user.
                        </p>
                      )}
                    </div>
                  </div>

                  {/*
                    Only when the engine takes it. Druid and the two search engines address
                    a datasource or an index by name in the statement, and libSQL addresses
                    the whole database by URL, so none of the four has a database to name
                    here - and `buildConnection` never wrote what this box collected.
                  */}
                  {takesConnectionField(type, "database") && (
                    <div className="space-y-2">
                      <div className="flex items-center gap-2 mb-1">
                        <Database strokeWidth={1.5} className="w-3 h-3 text-fg-muted" />
                        <Label htmlFor="database" className="text-xs font-mediumr text-fg-muted">
                          {databaseFieldLabel} Name
                        </Label>
                      </div>
                      <Input
                        id="database"
                        value={database}
                        onChange={(e) => setDatabase(e.target.value)}
                        placeholder={databaseFieldPlaceholder}
                        className="h-10 bg-panel border-hairline focus:border-brand-tint/50 transition-all text-xs font-mono"
                      />
                      {isTrino && (
                        <p className="text-xs text-fg-muted">
                          The Trino catalog to open, such as tpch or hive. Its schemas are the level below.
                        </p>
                      )}
                      {isCassandra && (
                        <p className="text-xs text-fg-muted">
                          The keyspace to open. Tables inside it are the level below; statements can still name any
                          keyspace in full.
                        </p>
                      )}
                    </div>
                  )}

                  {takesConnectionField(type, "schema") && (
                    <div className="space-y-2">
                      <div className="flex items-center gap-2 mb-1">
                        <Database strokeWidth={1.5} className="w-3 h-3 text-fg-muted" />
                        <Label htmlFor="schema" className="text-xs font-mediumr text-fg-muted">
                          Schema Name
                        </Label>
                      </div>
                      <Input
                        id="schema"
                        value={schema}
                        onChange={(e) => setSchema(e.target.value)}
                        placeholder="default"
                        className="h-10 bg-panel border-hairline focus:border-brand-tint/50 transition-all text-xs font-mono"
                      />
                      <p className="text-xs text-fg-muted">
                        Used for unqualified table names in queries and Create Table. Leave empty to qualify names
                        yourself. Run SHOW SCHEMAS to list the catalog's schemas.
                      </p>
                    </div>
                  )}

                  {/*
                    In the open rather than behind the Advanced accordion for the
                    reason Cassandra's field below is: the deployment that needs it is
                    the ordinary one, and the failure without it is a credentials error
                    that names nothing. The connection-string mode has no such field -
                    a pasted URI carries `?authSource=` itself.
                  */}
                  {isMongoDB && (
                    <div className="space-y-2">
                      <div className="flex items-center gap-2 mb-1">
                        <Key strokeWidth={1.5} className="w-3 h-3 text-fg-muted" />
                        <Label htmlFor="authSource" className="text-xs font-medium text-fg-muted">
                          Authentication Database
                        </Label>
                      </div>
                      <Input
                        id="authSource"
                        value={authSource}
                        onChange={(e) => setAuthSource(e.target.value)}
                        placeholder="admin"
                        className="h-10 bg-panel border-hairline focus:border-brand-tint/50 transition-all text-xs font-mono"
                      />
                      <p className="text-xs text-fg-muted">
                        The database the user was created in, usually admin. Leave empty when the credentials live in
                        the database above.
                      </p>
                    </div>
                  )}

                  {/*
                    Rendered in the open, not behind the Advanced accordion that holds
                    Oracle's service name and SQL Server's instance name. Those two are
                    refinements; this one is mandatory - `cassandra-driver` refuses to
                    build a load-balancing policy without it, so a connection with this
                    empty cannot open at all.
                  */}
                  {isCassandra && (
                    <div className="space-y-2">
                      <div className="flex items-center gap-2 mb-1">
                        <Server strokeWidth={1.5} className="w-3 h-3 text-fg-muted" />
                        <Label htmlFor="localDataCenter" className="text-xs font-medium text-fg-muted">
                          Local Data Center
                        </Label>
                      </div>
                      <Input
                        id="localDataCenter"
                        value={localDataCenter}
                        onChange={(e) => setLocalDataCenter(e.target.value)}
                        placeholder="datacenter1"
                        className="h-10 bg-panel border-hairline focus:border-brand-tint/50 transition-all text-xs font-mono"
                      />
                      <p className="text-xs text-fg-muted">
                        Required: the Cassandra driver refuses to connect without it. A stock single-node install
                        reports datacenter1; the server lists the ones it has if this is wrong.
                      </p>
                    </div>
                  )}
                </>
              )}
            </>
          </div>

          {/* Advanced Settings (Oracle/MSSQL) */}
          {(type === "oracle" || type === "mssql") && (
            <div className="space-y-2">
              <button
                type="button"
                onClick={() => setShowAdvanced(!showAdvanced)}
                className="flex items-center gap-2 w-full px-3 py-2 rounded-lg border border-hairline hover:border-hairline-strong bg-panel text-xs font-medium text-fg-tertiary hover:text-fg transition-all"
              >
                <Settings2 strokeWidth={1.5} className="w-3.5 h-3.5 text-hue-orange" />
                <span>Advanced</span>
                {(serviceName || instanceName) && (
                  <span className="ml-1 px-1.5 py-0.5 rounded text-[0.625rem] bg-hue-orange-tint/10 text-hue-orange border border-hue-orange-tint/20">
                    SET
                  </span>
                )}
                <ChevronDown className={cn("w-3 h-3 ml-auto transition-transform", showAdvanced && "rotate-180")} />
              </button>
              <AnimatePresence>
                {showAdvanced && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: "auto", opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    className="overflow-hidden"
                  >
                    <div className="p-3 rounded-lg border border-hue-orange-tint/10 bg-hue-orange-tint/5 space-y-3">
                      {type === "oracle" && (
                        <div className="space-y-1.5">
                          <Label className="text-xs font-mediumr text-fg-muted">Service Name</Label>
                          <Input
                            value={serviceName}
                            onChange={(e) => setServiceName(e.target.value)}
                            placeholder="ORCL or XEPDB1"
                            className="h-9 bg-panel border-hairline focus:border-hue-orange-tint/50 text-xs"
                          />
                          <p className="text-xs text-fg-muted">
                            If empty, the Database Name field is used as the service name.
                          </p>
                        </div>
                      )}
                      {type === "mssql" && (
                        <div className="space-y-1.5">
                          <Label className="text-xs font-mediumr text-fg-muted">Instance Name</Label>
                          <Input
                            value={instanceName}
                            onChange={(e) => setInstanceName(e.target.value)}
                            placeholder="SQLEXPRESS"
                            className="h-9 bg-panel border-hairline focus:border-hue-orange-tint/50 text-xs"
                          />
                          <p className="text-xs text-fg-muted">
                            For named instances (e.g. SQLEXPRESS). Leave empty for default instance.
                          </p>
                        </div>
                      )}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          )}

          {/* SSL/TLS & SSH Panels - only for non-file-based providers */}
          {!isFileBased(type) && (
            <div className="space-y-2">
              {/* SSL/TLS Toggle */}
              <button
                type="button"
                onClick={() => setShowSSL(!showSSL)}
                className="flex items-center gap-2 w-full px-3 py-2 rounded-lg border border-hairline hover:border-hairline-strong bg-panel text-xs font-medium text-fg-tertiary hover:text-fg transition-all"
              >
                <Lock strokeWidth={1.5} className="w-3.5 h-3.5 text-hue-emerald" />
                <span>SSL / TLS</span>
                {sslMode !== "disable" && (
                  <span className="ml-1 px-1.5 py-0.5 rounded text-[0.625rem] bg-hue-emerald-tint/10 text-hue-emerald border border-hue-emerald-tint/20">
                    {sslMode.toUpperCase()}
                  </span>
                )}
                <ChevronDown className={cn("w-3 h-3 ml-auto transition-transform", showSSL && "rotate-180")} />
              </button>
              <AnimatePresence>
                {showSSL && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: "auto", opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    className="overflow-hidden"
                  >
                    <div className="p-3 rounded-lg border border-hue-emerald-tint/10 bg-hue-emerald-tint/5 space-y-3">
                      <div className="space-y-2">
                        <Label className="text-xs font-mediumr text-fg-muted">SSL Mode</Label>
                        <div className="flex flex-wrap gap-1.5">
                          {(["disable", "require", "verify-system", "verify-ca", "verify-full"] as SSLMode[]).map(
                            (mode) => (
                              <button
                                key={mode}
                                type="button"
                                onClick={() => setSSLMode(mode)}
                                className={cn(
                                  "px-2.5 py-1.5 rounded-md text-xs font-mediumr transition-all border",
                                  sslMode === mode
                                    ? "border-hue-emerald-tint/30 bg-hue-emerald-tint/10 text-hue-emerald"
                                    : "border-transparent text-fg-muted hover:text-fg-secondary hover:bg-fill",
                                )}
                              >
                                {mode}
                              </button>
                            ),
                          )}
                        </div>
                        <p data-testid="ssl-mode-hint" className="text-xs text-fg-muted">
                          {SSL_MODE_HINTS[sslMode]}
                        </p>
                      </div>
                      {sslMode !== "disable" && (
                        <div className="space-y-3">
                          <div className="space-y-1.5">
                            <Label className="text-xs font-mediumr text-fg-muted">CA Certificate (PEM)</Label>
                            <textarea
                              value={caCert}
                              onChange={(e) => setCaCert(e.target.value)}
                              placeholder="-----BEGIN CERTIFICATE-----&#10;Paste CA cert content here...&#10;-----END CERTIFICATE-----"
                              rows={3}
                              className="w-full rounded-md bg-panel border border-hairline focus:border-hue-emerald-tint/50 text-xs font-mono text-fg-secondary p-2 resize-none placeholder:text-fg-subtle"
                            />
                          </div>
                          {(sslMode === "verify-ca" || sslMode === "verify-full") && (
                            <>
                              <div className="space-y-1.5">
                                <Label className="text-xs font-mediumr text-fg-muted">Client Certificate (PEM)</Label>
                                <textarea
                                  value={clientCert}
                                  onChange={(e) => setClientCert(e.target.value)}
                                  placeholder="-----BEGIN CERTIFICATE-----&#10;Optional client cert...&#10;-----END CERTIFICATE-----"
                                  rows={3}
                                  className="w-full rounded-md bg-panel border border-hairline focus:border-hue-emerald-tint/50 text-xs font-mono text-fg-secondary p-2 resize-none placeholder:text-fg-subtle"
                                />
                              </div>
                              <div className="space-y-1.5">
                                <Label className="text-xs font-mediumr text-fg-muted">Client Private Key (PEM)</Label>
                                <textarea
                                  value={clientKey}
                                  onChange={(e) => setClientKey(e.target.value)}
                                  placeholder="-----BEGIN PRIVATE KEY-----&#10;Optional client key...&#10;-----END PRIVATE KEY-----"
                                  rows={3}
                                  className="w-full rounded-md bg-panel border border-hairline focus:border-hue-emerald-tint/50 text-xs font-mono text-fg-secondary p-2 resize-none placeholder:text-fg-subtle"
                                />
                              </div>
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* SSH (docs/CONTEXT.md §4.9): a profile declared once, never a bastion typed per datasource. */}
              <div className="space-y-1.5">
                <Label htmlFor="ssh-profile" className="text-xs text-fg-tertiary">
                  SSH tunnel
                </Label>
                <Select
                  value={sshProfile || "none"}
                  onValueChange={(value) => setSshProfile(value === "none" ? "" : value)}
                >
                  <SelectTrigger
                    id="ssh-profile"
                    aria-label="SSH tunnel"
                    className="h-9 w-full bg-panel border-hairline-strong text-xs"
                  >
                    <SelectValue placeholder="No tunnel" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">No tunnel - direct connection</SelectItem>
                    {(sshProfiles ?? []).map((profile) => (
                      <SelectItem key={profile.id} value={profile.id}>
                        <Terminal strokeWidth={1.5} className="w-3.5 h-3.5 text-hue-purple" />
                        <span>
                          {profile.name}
                          <span className="text-fg-muted">
                            {" "}
                            · {profile.username}@{profile.host}
                          </span>
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {(sshProfiles ?? []).length === 0 && (
                  <p className="text-[11px] text-fg-muted">
                    No SSH profile declared yet. Profiles are declared once, below the datasource list, and referenced
                    here.
                  </p>
                )}
              </div>
            </div>
          )}

          {/* Test Result */}
          <AnimatePresence>
            {testResult && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                className="overflow-hidden"
              >
                <div
                  data-testid="connection-test-result"
                  data-tone={testResult.tone}
                  className={cn(
                    "flex items-center gap-2 p-3 rounded-lg border text-xs",
                    testResult.tone === "success"
                      ? "bg-success-tint/5 border-success-tint/20 text-success"
                      : testResult.tone === "warning"
                        ? "bg-warning-tint/5 border-warning-tint/20 text-warning"
                        : "bg-danger-tint/5 border-danger-tint/20 text-danger",
                  )}
                >
                  {testResult.tone === "success" ? (
                    <CircleCheck strokeWidth={1.5} className="w-3.5 h-3.5 shrink-0" />
                  ) : testResult.tone === "warning" ? (
                    <TriangleAlert strokeWidth={1.5} className="w-3.5 h-3.5 shrink-0" />
                  ) : (
                    <CircleX strokeWidth={1.5} className="w-3.5 h-3.5 shrink-0" />
                  )}
                  <span className="leading-relaxed">{testResult.message}</span>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>

      {/* Sticky footer */}
      <div className="shrink-0 bg-panel p-4 md:p-6 border-t border-hairline">
        <div className="flex flex-col-reverse gap-3 md:flex-row md:items-center md:justify-between">
          <Button
            variant="ghost"
            onClick={onClose}
            className="w-full md:w-auto text-fg-muted hover:text-fg hover:bg-fill text-xs font-medium"
          >
            Cancel
          </Button>
          <div className="flex flex-col gap-2 md:flex-row md:items-center md:gap-2">
            <Button
              variant="outline"
              onClick={handleTestConnection}
              disabled={isTesting}
              className="w-full md:w-auto border-hairline-strong text-fg-tertiary hover:text-fg-bright hover:bg-fill text-xs font-medium h-10 px-4"
            >
              {isTesting ? (
                <div className="flex items-center gap-2">
                  {/* On an outline button, so the spinner follows the text ramp. */}
                  <div className="w-3 h-3 border-2 border-fg-tertiary/30 border-t-fg-tertiary rounded-full animate-spin" />
                  Testing...
                </div>
              ) : (
                "Test Connection"
              )}
            </Button>
            <Button
              onClick={handleConnect}
              disabled={
                isTesting ||
                (getDBConfig(type).showConnectionStringToggle &&
                  mongoConnectionMode === "connectionString" &&
                  !connectionString.trim())
              }
              className="w-full md:w-auto min-w-0 md:min-w-[140px] bg-brand-solid hover:bg-brand-solid-hover text-white font-medium text-xs h-10 shadow-lg shadow-blue-900/20 group relative overflow-hidden"
            >
              <AnimatePresence mode="wait">
                {isTesting ? (
                  <motion.div
                    key="testing"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="flex items-center gap-2"
                  >
                    {/* Inside a solid blue button — white is right on either ground. */}
                    <div className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    Connecting...
                  </motion.div>
                ) : (
                  <motion.div
                    key="connect"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="flex items-center gap-2"
                  >
                    {submitText}
                  </motion.div>
                )}
              </AnimatePresence>
            </Button>
          </div>
        </div>
      </div>
    </>
  );

  if (isMobile) {
    return (
      <Drawer
        open={isOpen}
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
      >
        <DrawerContent className="max-h-[95dvh] bg-surface border-hairline text-fg p-0 flex flex-col">
          <DrawerHeader className="sr-only">
            <DrawerTitle>{title}</DrawerTitle>
            <DrawerDescription>Configure database connection parameters.</DrawerDescription>
          </DrawerHeader>
          {formContent}
        </DrawerContent>
      </Drawer>
    );
  }

  // A right-anchored sheet at half the viewport rather than a centred dialog (docs/CONTEXT.md
  // §4.8): the form is long, and the list it was opened from stays in view beside it.
  return (
    <Sheet open={isOpen} onOpenChange={onClose}>
      <SheetContent side="right" className={`${CONFIG_SHEET_CLASS} p-0 gap-0`} showCloseButton={false}>
        <SheetTitle className="sr-only">{title}</SheetTitle>
        <SheetDescription className="sr-only">Configure database connection parameters.</SheetDescription>
        {formContent}
      </SheetContent>
    </Sheet>
  );
}
