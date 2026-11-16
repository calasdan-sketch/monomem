// Constants shared by store.ts and src/store/migrate.ts (moved out of store.ts unchanged).

/** How long change-log rows (incl. deletes) are kept for the change feed. */
export const CHANGE_LOG_RETENTION_DAYS = 90;

/** FTS5 prefix index on 1-character prefixes (see Store.ensureFtsPrefixIndex). */
export const FTS_PREFIX_OPT = "prefix='1'";

/** SQLite expression for "now" as an ISO-8601 string (same shape as Date#toISOString). */
export const SQL_NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

export const DEFAULT_NAMESPACE = "default";
