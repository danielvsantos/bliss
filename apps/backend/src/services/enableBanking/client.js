/**
 * Process-wide Enable Banking client for the backend (#132), built from the
 * environment on first use. `isEnableBankingEnabled()` is false (and the client
 * null) when ENABLE_BANKING_APP_ID or the private key is missing.
 */

const {
    createClient,
    loadPrivateKey,
    getEnableBankingConfig,
} = require('@bliss/shared/enablebanking');

let client = null;

function isEnableBankingEnabled() {
    return getEnableBankingConfig().enabled;
}

function getEnableBankingClient() {
    if (client) return client;
    const config = getEnableBankingConfig();
    if (!config.enabled) return null;
    client = createClient({ appId: config.appId, privateKey: loadPrivateKey(), baseUrl: config.baseUrl });
    return client;
}

/** Tests only. */
function __setEnableBankingClientForTests(c) {
    client = c;
}

module.exports = { getEnableBankingClient, isEnableBankingEnabled, __setEnableBankingClientForTests };
