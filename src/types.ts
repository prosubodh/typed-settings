import type { StandardSchemaV1 } from '@standard-schema/spec';

export type Flat = Record<string, string | undefined>;

export interface SecretProvider {
  name: string;
  load(): Promise<Flat> | Flat;
}

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

export type ArrayStrategy = 'replace' | 'concat' | 'mergeIndex';
export type UnknownKeys = 'strip' | 'preserve' | 'reject';

export interface SettingsOptions<S extends StandardSchemaV1 = StandardSchemaV1> {
  schema: S;
  sources?: SourceInput[];
  prefix?: string;
  separator?: '__';
  coerce?: boolean; // default true
  expand?: boolean; // default true
  expandSecrets?: boolean; // default false
  arrayStrategy?: ArrayStrategy; // default 'replace'
  unknownKeys?: UnknownKeys; // default 'strip'
  freeze?: boolean; // default true
  timeoutMs?: number; // default 5000, async only
  maxBytes?: number;
  envMap?: Record<string, string>;
  allowUnresolved?: boolean; // default false
  env?: Flat; // injectable env snapshot (Edge-safe). Defaults to process.env when available.
}
