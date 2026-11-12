import { setSpecStatusSchema, type SetSpecStatusInput, type StoredSpec } from '@mandate/shared';
import type { CommitMeta, Storage } from './index.js';

/**
 * Change a spec's status (service for MCP tools). Moving to `done` passes through the
 * done gate in the storage layer, so it fails with 409 `done_gate` listing unverified criteria.
 */
export async function setSpecStatus(storage: Pick<Storage, 'specs'>, input: SetSpecStatusInput, meta: CommitMeta = {}): Promise<StoredSpec> {
  const { id, status } = setSpecStatusSchema.parse(input);
  return storage.specs.update(id, { status } as never, { ...meta, message: meta.message ?? `spec(${id}): ${status}` });
}
