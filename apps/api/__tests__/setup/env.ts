// Loads .env.test into process.env BEFORE any module is imported.
// This is critical for integration tests that need DATABASE_URL pointing to bliss_test,
// and for modules that read env vars at load time (e.g. encryption.js).
import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load test-specific overrides first (e.g. DATABASE_URL → bliss_test)
config({ path: resolve(__dirname, '../../.env.test') });

// Then load root .env for all other vars (dotenv won't overwrite existing values)
config({ path: resolve(__dirname, '../../../../.env') });

// Ensure required test defaults are always set (override any loaded value)
process.env.ENCRYPTION_SECRET = 'test-secret-that-is-exactly-32-by';
process.env.JWT_SECRET_CURRENT = 'test-jwt-secret';
process.env.INTERNAL_API_KEY = 'test-internal-api-key';
