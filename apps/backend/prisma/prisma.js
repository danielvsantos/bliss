const { PrismaClient } = require('@prisma/client');
const { Decimal } = require('@prisma/client/runtime/library');
const { encrypt, decrypt, encryptedFields } = require('../src/utils/encryption');

// Prisma 6 removed $use() middleware — use $extends with $allOperations instead.
// We combine encryption + validation into a single extension to preserve the
// original execution order: encrypt → validate → DB → decrypt.
const prisma = new PrismaClient({
  log: ['warn', 'error'],
}).$extends({
  query: {
    $allModels: {
      async $allOperations({ model, operation, args, query }) {

        // ───── 1. Encryption (pre-query) ─────────────────────────────────────
        if (encryptedFields[model]) {
          const fieldsToEncrypt = encryptedFields[model];

          if (operation === 'create' || operation === 'update') {
            if (args.data) {
              for (const [field, config] of Object.entries(fieldsToEncrypt)) {
                if (args.data[field]) {
                  args.data[field] = encrypt(args.data[field], config.searchable);
                }
              }
            }
          }

          if (operation === 'upsert') {
            if (args.create) {
              for (const [field, config] of Object.entries(fieldsToEncrypt)) {
                if (args.create[field]) {
                  args.create[field] = encrypt(args.create[field], config.searchable);
                }
              }
            }
            if (args.update) {
              for (const [field, config] of Object.entries(fieldsToEncrypt)) {
                if (args.update[field]) {
                  args.update[field] = encrypt(args.update[field], config.searchable);
                }
              }
            }
          }

          if (operation === 'createMany') {
            if (Array.isArray(args.data)) {
              args.data = args.data.map(record => {
                const updated = { ...record };
                for (const [field, config] of Object.entries(fieldsToEncrypt)) {
                  if (updated[field]) {
                    updated[field] = encrypt(updated[field], config.searchable);
                  }
                }
                return updated;
              });
            }
          }

          if (operation === 'updateMany') {
            if (args.data) {
              for (const [field, config] of Object.entries(fieldsToEncrypt)) {
                if (args.data[field]) {
                  args.data[field] = encrypt(args.data[field], config.searchable);
                }
              }
            }
          }

          if (args.where) {
            for (const [field, config] of Object.entries(fieldsToEncrypt)) {
              if (args.where[field] && config.searchable) {
                args.where[field] = encrypt(args.where[field], true);
              }
            }
          }
        }

        // ───── 2. Validation (pre-query) ──────────────────────────────────────

        // User validation
        if (model === 'User' && (operation === 'create' || operation === 'update')) {
          const data = args.data;
          if (data.name && (data.name.length < 2 || data.name.length > 100)) {
            throw new Error('User name must be between 2 and 100 characters.');
          }
        }

        // Tenant validation
        if (model === 'Tenant' && (operation === 'create' || operation === 'update')) {
          const data = args.data;
          const nameIsBeingSet = data.name !== undefined;
          if (operation === 'create' || nameIsBeingSet) {
            if (!data.name || data.name.length < 2 || data.name.length > 100) {
              throw new Error('Tenant name must be between 2 and 100 characters.');
            }
          }
        }


        // Transaction validation
        if (model === 'Transaction' && (operation === 'create' || operation === 'update')) {
          const data = args.data;
          if (data.currency && !/^[A-Z]{3}$/.test(data.currency)) {
            throw new Error('Invalid currency code: Must be a valid ISO code (3 uppercase letters).');
          }
          if (data.credit && new Decimal(data.credit).isNegative()) {
            throw new Error('Credit amount must be positive.');
          }
          if (data.debit && new Decimal(data.debit).isNegative()) {
            throw new Error('Debit amount must be positive.');
          }
          if (data.transaction_date && new Date(data.transaction_date) > new Date()) {
            throw new Error('Transaction date cannot be in the future.');
          }
          const hasCreditField = 'credit' in data;
          const hasDebitField = 'debit' in data;
          if (data.credit && data.debit) {
            throw new Error('Transaction cannot have both credit and debit amounts.');
          }
          if (operation === 'create' && !data.credit && !data.debit) {
            throw new Error('Transaction must have either a credit or debit amount.');
          }
          if (operation === 'update' && (hasCreditField || hasDebitField) && !data.credit && !data.debit) {
            throw new Error('Transaction must have either a credit or debit amount.');
          }
        }

        // Account validation
        if (model === 'Account' && (operation === 'create' || operation === 'update')) {
          const data = args.data;
          if (operation === 'create' || data.name !== undefined) {
            if (!data.name || data.name.length < 2 || data.name.length > 50) {
              throw new Error('Account name must be between 2 and 50 characters.');
            }
          }
          if (operation === 'create' || data.accountNumber !== undefined) {
            if (!data.accountNumber || data.accountNumber.length < 4 || data.accountNumber.length > 100) {
              throw new Error('Account number must be between 4 and 100 characters.');
            }
          }
          if (data.currencyCode && !/^[A-Z]{3}$/.test(data.currencyCode)) {
            throw new Error('Invalid currencyCode: Must be a valid ISO 3-letter currency code.');
          }
          if (data.countryId && !/^[A-Z]{3}$/.test(data.countryId)) {
            throw new Error('Invalid countryId: Must be a valid ISO 3166-1 alpha-3 country code.');
          }
        }

        // Category validation
        if (model === 'Category' && (operation === 'create' || operation === 'update')) {
          const data = args.data;
          if (!data.name || data.name.length < 2 || data.name.length > 30) {
            throw new Error('Category name must be between 2 and 30 characters.');
          }
          if (data.description && data.description.length > 200) {
            throw new Error('Category description must not exceed 200 characters.');
          }
        }

        // StockPrice validation
        if (model === 'StockPrice' && (operation === 'create' || operation === 'update')) {
          const data = args.data;
          if (data.price && data.price <= 0) {
            throw new Error('Stock price must be positive.');
          }
          if (!data.ticker || data.ticker.length < 1 || data.ticker.length > 10) {
            throw new Error('Stock ticker must be between 1 and 10 characters.');
          }
          if (data.date && new Date(data.date) > new Date()) {
            throw new Error('Stock price date cannot be in the future.');
          }
        }

        // AssetPrice validation
        if (model === 'AssetPrice' && (operation === 'create' || operation === 'update')) {
          const data = args.data;
          if (data.price && new Decimal(data.price).isNegative()) {
            throw new Error('Asset price must be positive.');
          }
          if (!data.symbol || data.symbol.length < 1 || data.symbol.length > 10) {
            throw new Error('Asset symbol must be between 1 and 10 characters.');
          }
          if (data.day && new Date(data.day) > new Date()) {
            throw new Error('Asset price date cannot be in the future.');
          }
        }

        // CurrencyRate validation
        if (model === 'CurrencyRate' && (operation === 'create' || operation === 'update')) {
          const data = args.data;
          if (!data.currencyFrom || !/^[A-Z]{3}$/.test(data.currencyFrom)) {
            throw new Error('Invalid currencyFrom code: Must be a valid ISO 3-letter currency code.');
          }
          if (!data.currencyTo || !/^[A-Z]{3}$/.test(data.currencyTo)) {
            throw new Error('Invalid currencyTo code: Must be a valid ISO 3-letter currency code.');
          }
          if (data.value !== undefined && (new Decimal(data.value).isNegative() || new Decimal(data.value).isZero())) {
            throw new Error('Conversion rate value must be a positive number.');
          }
          if (data.month !== undefined && (data.month < 1 || data.month > 12)) {
            throw new Error('Month must be between 1 and 12.');
          }
          if (data.year !== undefined && (data.year < 1900 || data.year > 2100)) {
            throw new Error('Year must be a valid 4-digit number.');
          }
          if (data.currencyFrom === data.currencyTo) {
            throw new Error('Currency conversion must be between different currencies.');
          }
        }

        // ───── 3. Execute query ───────────────────────────────────────────────
        const result = await query(args);

        // ───── 4. Decryption (post-query) ─────────────────────────────────────
        if (encryptedFields[model]) {
          const fieldsToDecrypt = Object.keys(encryptedFields[model]);

          if (operation === 'findUnique' || operation === 'findFirst' || operation === 'findMany' ||
              operation === 'create' || operation === 'update' || operation === 'upsert') {
            if (Array.isArray(result)) {
              for (const item of result) {
                for (const field of fieldsToDecrypt) {
                  if (item[field]) {
                    item[field] = decrypt(item[field]);
                  }
                }
              }
            } else if (result) {
              for (const field of fieldsToDecrypt) {
                if (result[field]) {
                  result[field] = decrypt(result[field]);
                }
              }
            }
          }
        }

        return result;
      }
    }
  }
});

module.exports = prisma;
