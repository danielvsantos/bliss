require('dotenv').config();
const { plaidClient } = require('./src/services/plaid');

async function testConnection() {
    try {
        console.log('Testing Plaid connection by fetching categories...');
        const response = await plaidClient.categoriesGet({});
        console.log(`✅ Success! Retrieved ${response.data.categories.length} categories.`);
        console.log('✅ Plaid credentials are valid and working.');
    } catch (error) {
        console.error('❌ Plaid connection failed:', error.response ? error.response.data : error.message);
        process.exit(1);
    }
}

testConnection();
