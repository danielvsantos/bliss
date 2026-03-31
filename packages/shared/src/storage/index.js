import { LocalStorageAdapter } from './LocalStorageAdapter.js';
import { GCSStorageAdapter } from './GCSStorageAdapter.js';

/**
 * Factory — returns a storage adapter based on the STORAGE_BACKEND env var.
 *
 * Supported values:
 *   "local" (default) — local filesystem via LOCAL_STORAGE_DIR
 *   "gcs"             — Google Cloud Storage via GCS_BUCKET_NAME
 *
 * @returns {LocalStorageAdapter | GCSStorageAdapter}
 */
export function createStorageAdapter() {
  const backend = (process.env.STORAGE_BACKEND || 'local').toLowerCase();

  if (backend === 'gcs') {
    return new GCSStorageAdapter();
  }

  return new LocalStorageAdapter();
}

export { LocalStorageAdapter, GCSStorageAdapter };
