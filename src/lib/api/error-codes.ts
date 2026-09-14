/**
 * API Error Codes
 * Single source of truth for all error codes used across server and client
 */

export const ApiErrorCode = {
  // Database errors
  QUERY_CANCELLED: "QUERY_CANCELLED",
  /** A write on an approval-gated datasource became a pending request (docs/CONTEXT.md §4.6). */
  APPROVAL_REQUIRED: "APPROVAL_REQUIRED",
  QUERY_ERROR: "QUERY_ERROR",
  CONFIG_ERROR: "CONFIG_ERROR",
  AUTH_ERROR: "AUTH_ERROR",
  TIMEOUT_ERROR: "TIMEOUT_ERROR",
  CONNECTION_ERROR: "CONNECTION_ERROR",
  POOL_EXHAUSTED: "POOL_EXHAUSTED",
  DATABASE_ERROR: "DATABASE_ERROR",

  // LLM errors
  LLM_SAFETY: "LLM_SAFETY",
  LLM_AUTH: "LLM_AUTH",
  LLM_RATE_LIMIT: "LLM_RATE_LIMIT",
  /** A person's statements on a datasource are at its `maxConcurrent` (docs/CONTEXT.md §4.16). */
  CONCURRENCY_LIMIT: "CONCURRENCY_LIMIT",
  LLM_CONFIG: "LLM_CONFIG",
  LLM_UNCONFIGURED: "LLM_UNCONFIGURED",
  LLM_STREAM: "LLM_STREAM",
  LLM_ERROR: "LLM_ERROR",

  // Application rate limiting (distinct from LLM_RATE_LIMIT, which is the provider's limit)
  RATE_LIMITED: "RATE_LIMITED",

  // Generic
  INTERNAL_ERROR: "INTERNAL_ERROR",
  NETWORK_ERROR: "NETWORK_ERROR",
} as const;

export type ApiErrorCode = (typeof ApiErrorCode)[keyof typeof ApiErrorCode];
