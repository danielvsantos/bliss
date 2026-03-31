/**
 * Google Cloud Storage adapter.
 *
 * Requires @google-cloud/storage to be installed.
 * Credentials from GCS_SERVICE_ACCOUNT_JSON (JSON string) or
 * GOOGLE_APPLICATION_CREDENTIALS (file path fallback).
 */
export class GCSStorageAdapter {
  constructor() {
    const bucketName = process.env.GCS_BUCKET_NAME;
    if (!bucketName) {
      throw new Error(
        'GCS_BUCKET_NAME environment variable is required when STORAGE_BACKEND=gcs'
      );
    }

    let Storage;
    try {
      // Dynamic import so the package is only required when STORAGE_BACKEND=gcs
      ({ Storage } = require('@google-cloud/storage'));
    } catch {
      throw new Error(
        '@google-cloud/storage is not installed. ' +
        'Run: pnpm add @google-cloud/storage   (or set STORAGE_BACKEND=local to use local filesystem)'
      );
    }

    const gcsCredentialsJson = process.env.GCS_SERVICE_ACCOUNT_JSON;
    if (gcsCredentialsJson) {
      const credentials = JSON.parse(gcsCredentialsJson);
      this.storage = new Storage({ credentials, projectId: credentials.project_id });
    } else {
      // Fallback: GOOGLE_APPLICATION_CREDENTIALS file path
      this.storage = new Storage();
    }

    this.bucketName = bucketName;
  }

  /**
   * Upload a local file to GCS.
   * @param {string} localPath — absolute path to the source file
   * @param {string} storageKey — GCS object key (e.g., "imports/1/uuid-file.csv")
   */
  async uploadFile(localPath, storageKey) {
    await this.storage.bucket(this.bucketName).upload(localPath, {
      destination: storageKey,
      gzip: true,
    });
  }

  /**
   * Download a file from GCS to a local destination.
   * @param {string} storageKey — GCS object key
   * @param {string} destPath — absolute path to write the file
   */
  async downloadFile(storageKey, destPath) {
    await this.storage
      .bucket(this.bucketName)
      .file(storageKey)
      .download({ destination: destPath });
  }

  /**
   * Delete a file from GCS. Best-effort — logs warning on failure.
   * @param {string} storageKey — GCS object key
   */
  async deleteFile(storageKey) {
    await this.storage.bucket(this.bucketName).file(storageKey).delete();
  }
}
