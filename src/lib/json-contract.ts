/** Versioned JSON contract shared by every machine-readable CLI result. */
export const JSON_SCHEMA_VERSION = '1.0.0' as const;

export interface JsonSuccessEnvelope<T = unknown> {
  schemaVersion: typeof JSON_SCHEMA_VERSION;
  success: true;
  data: T;
}

export function jsonSuccess<T>(data: T): JsonSuccessEnvelope<T> {
  return { schemaVersion: JSON_SCHEMA_VERSION, success: true, data };
}
