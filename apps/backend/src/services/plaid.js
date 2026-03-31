const { Configuration, PlaidApi, PlaidEnvironments } = require('plaid');
const logger = require('../utils/logger');

const PLAID_CLIENT_ID = process.env.PLAID_CLIENT_ID;
const PLAID_SECRET = process.env.PLAID_SECRET;
const PLAID_ENV = process.env.PLAID_ENV || 'sandbox';

if (!PLAID_CLIENT_ID || !PLAID_SECRET) {
    logger.warn('Plaid credentials not found in environment variables. Plaid service will not function.');
}

const configuration = new Configuration({
    basePath: PlaidEnvironments[PLAID_ENV],
    baseOptions: {
        headers: {
            'PLAID-CLIENT-ID': PLAID_CLIENT_ID,
            'PLAID-SECRET': PLAID_SECRET,
        },
        timeout: 30_000, // 30s — prevents hanging calls from blocking workers
    },
});

const plaidClient = new PlaidApi(configuration);

logger.info(`Plaid Service initialized in ${PLAID_ENV} mode.`);

module.exports = { plaidClient };
