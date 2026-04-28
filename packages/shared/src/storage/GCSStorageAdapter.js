/**
 * Google Cloud Storage adapter.
 *
 * Requires @google-cloud/storage to be installed.
 * Credentials from GCS_SERVICE_ACCOUNT_JSON (JSON string) or
 * GOOGLE_APPLICATION_CREDENTIALS (file path fallback).
 *
 * Uses lazy async import() so this works in both ESM (Vercel/Next.js) and CJS
 * (Express/backend) runtimes — synchronous require() fails in ESM contexts.
 */
export class GCSStorageAdapter {
  constructor() {
    const bucketName = process.env.GCS_BUCKET_NAME;
    if (!bucketName) {
      throw new Error(
        'GCS_BUCKET_NAME environment variable is required when STORAGE_BACKEND=gcs'
      );
    }
    this.bucketName = bucketName;
    this._storage = null;
  }

  async _getStorage() {
    if (this._storage) return this._storage;

    let Storage;
    try {
      ({ Storage } = await import('@google-cloud/storage'));
    } catch {
      throw new Error(
        '@google-cloud/storage is not installed. ' +
        'Run: pnpm add @google-cloud/storage   (or set STORAGE_BACKEND=local to use local filesystem)'
      );
    }

    const gcsCredentialsJson = process.env.GCS_SERVICE_ACCOUNT_JSON;
    if (gcsCredentialsJson) {
      const credentials = JSON.parse(gcsCredentialsJson);
      this._storage = new Storage({ credentials, projectId: credentials.project_id });
    } else {
      this._storage = new Storage();
    }

    return this._storage;
  }

  async uploadFile(localPath, storageKey) {
    const storage = await this._getStorage();
    await storage.bucket(this.bucketName).upload(localPath, {
      destination: storageKey,
      gzip: true,
    });
  }

  async downloadFile(storageKey, destPath) {
    const storage = await this._getStorage();
    await storage.bucket(this.bucketName).file(storageKey).download({ destination: destPath });
  }

  async deleteFile(storageKey) {
    const storage = await this._getStorage();
    await storage.bucket(this.bucketName).file(storageKey).delete();
  }
}
