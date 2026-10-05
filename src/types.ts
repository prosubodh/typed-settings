import type { StandardSchemaV1 } from '@standard-schema/spec';

/** Flat string map: the currency every source compiles to (`process.env` shape). */
export type Flat = Record<string, string | undefined>;

/** A secret backend. `load()` may be sync or async; async forces `settingsAsync()`. */
export interface SecretProvider {
  /** Label used in error attribution (`from`) and timeouts. */
  name: string;
  load(): Promise<Flat> | Flat;
}

/**
 * One config source. Strings `'env' | '.env' | '.env.local'` are built-ins,
 * any other string is a file path; objects cover inline text, files,
 * secrets dirs (resolved by the caller), maps, and providers.
 */
export type SourceInput =
  | 'env'
  | '.env'
  | '.env.local'
  | { text: string }
  | { file: string }
  | { dir: string }
  | { map: Flat; prefix?: string }
  | { provider: SecretProvider; prefix?: string }
  | SecretProvider
  | Flat
  | string; // file path shorthand

/** How arrays merge across layers: wholesale win, append, or per-index union. */
export type ArrayStrategy = 'replace' | 'concat' | 'mergeIndex';
/** What to do with input keys the schema doesn't declare. */
export type UnknownKeys = 'strip' | 'preserve' | 'reject';

/** Options for `settings()` / `settingsAsync()`. Full semantics in docs/configuration.md. */
export interface SettingsOptions<S extends StandardSchemaV1 = StandardSchemaV1> {
  /** Validating schema (zod/valibot/arktype natively, yup/joi/superstruct via bridges). */
  schema: S;
  /** Ordered layers, later wins. Default `['.env', 'env']`. */
  sources?: SourceInput[];
  /** Global prefix strip (case-insensitive, once). */
  prefix?: string;
  /** Fixed to `'__'`; only double underscores split keys. */
  separator?: '__';
  /** Best-effort leaf coercion before validation. Default true. */
  coerce?: boolean; // default true
  /** `$VAR` expansion after merging. Default true. */
  expand?: boolean; // default true
  /** Also expand `$VAR` inside vault-provided values. Default false. */
  expandSecrets?: boolean; // default false
  /** Cross-layer array merge. Default 'replace'. */
  arrayStrategy?: ArrayStrategy; // default 'replace'
  /** Undeclared keys: drop, keep, or throw. Default 'strip'. */
  unknownKeys?: UnknownKeys; // default 'strip'
  /** Deep-freeze the result. Default true. */
  freeze?: boolean; // default true
  /** Async provider + validation timeout in ms. Default 5000, async only. */
  timeoutMs?: number; // default 5000, async only
  /** Per-file read cap in UTF-8 bytes. Default 2 MiB. */
  maxBytes?: number;
  /** Keys used literally: no prefix strip, no `__` split. */
  envMap?: Record<string, string>;
  /** Keep `${MISSING}` literally instead of throwing. Default false. */
  allowUnresolved?: boolean; // default false
  /** Injectable env snapshot (tests, Edge). Defaults to process.env when available. */
  env?: Flat; // injectable env snapshot (Edge-safe). Defaults to process.env when available.
}
