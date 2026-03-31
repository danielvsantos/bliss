import fs from 'fs';
import path from 'path';

/**
 * Local filesystem storage adapter.
 *
 * Stores files under LOCAL_STORAGE_DIR (default: ./data/uploads).
 * Suitable for Docker Compose, self-hosted, and local development.
 */
export class LocalStorageAdapter {
  constructor() {
    this.baseDir = process.env.LOCAL_STORAGE_DIR || './data/uploads';
  }

  /**
   * Upload (copy) a local file to the storage directory.
   * @param {string} localPath — absolute path to the source file
   * @param {string} storageKey — relative key (e.g., "imports/1/uuid-file.csv")
   */
  async uploadFile(localPath, storageKey) {
    const destPath = path.join(this.baseDir, storageKey);
    const destDir = path.dirname(destPath);

    // Create parent directories if they don't exist
    fs.mkdirSync(destDir, { recursive: true });
    fs.copyFileSync(localPath, destPath);
  }

  /**
   * Download (copy) a file from storage to a local destination.
   * @param {string} storageKey — relative key
   * @param {string} destPath — absolute path to write the file
   */
  async downloadFile(storageKey, destPath) {
    const srcPath = path.join(this.baseDir, storageKey);

    if (!fs.existsSync(srcPath)) {
      throw new Error(`File not found in local storage: ${storageKey}`);
    }

    const destDir = path.dirname(destPath);
    fs.mkdirSync(destDir, { recursive: true });
    fs.copyFileSync(srcPath, destPath);
  }

  /**
   * Delete a file from storage. Best-effort — does not throw if missing.
   * @param {string} storageKey — relative key
   */
  async deleteFile(storageKey) {
    const filePath = path.join(this.baseDir, storageKey);
    try {
      fs.unlinkSync(filePath);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      // File already gone — that's fine
    }
  }
}
