// Loads .env.test into process.env BEFORE any module is require()'d.
// This is critical for modules that read env vars at load time (e.g. encryption.js).
const path = require('path');

// Load test-specific overrides first (e.g. DATABASE_URL → bliss_test)
require('dotenv').config({ path: path.resolve(__dirname, '../../../.env.test') });

// Then load root .env for all other vars (dotenv won't overwrite existing values)
require('dotenv').config({ path: path.resolve(__dirname, '../../../../../.env') });
