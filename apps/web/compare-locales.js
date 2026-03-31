#!/usr/bin/env node

/**
 * This script compares locale files to find missing translations.
 * It assumes that English (en.ts) is the base locale that contains all keys.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Colors for console output
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
};

const LOCALES_DIR = path.join(__dirname, 'client', 'src', 'i18n', 'locales');

// Helper function to recursively find missing keys between two objects
function findMissingKeys(enObj, otherObj, path = '') {
  const missing = [];

  for (const key in enObj) {
    const newPath = path ? `${path}.${key}` : key;
    
    if (!(key in otherObj)) {
      missing.push(newPath);
    } else if (typeof enObj[key] === 'object' && enObj[key] !== null && 
               typeof otherObj[key] === 'object' && otherObj[key] !== null) {
      const nestedMissing = findMissingKeys(enObj[key], otherObj[key], newPath);
      missing.push(...nestedMissing);
    }
  }

  return missing;
}

// Main function to compare locales
async function compareLocales() {
  console.log(`${colors.cyan}Checking for missing translations...${colors.reset}`);

  try {
    // Get all locale files
    const localeFiles = fs.readdirSync(LOCALES_DIR)
      .filter(file => file.endsWith('.ts'))
      .map(file => path.join(LOCALES_DIR, file));

    // Find the English locale file
    const enLocalePath = localeFiles.find(file => path.basename(file) === 'en.ts');
    if (!enLocalePath) {
      throw new Error('English locale file (en.ts) not found');
    }

    // Read English locale content
    let enContent = fs.readFileSync(enLocalePath, 'utf8');
    
    // Extract the locale object (assumes format: export default { ... })
    const enMatch = enContent.match(/export\s+default\s+(\{[\s\S]*\})/);
    if (!enMatch) {
      throw new Error('Could not parse English locale file');
    }

    // Convert to proper JSON-like string by replacing trailing commas
    let enJsonStr = enMatch[1].replace(/,(\s*[}\]])/g, '$1');
    
    // Handle exporting functions which won't parse as JSON
    enJsonStr = enJsonStr.replace(/:\s*\([^)]*\)\s*=>\s*\{[^}]*\}/g, ': "__FUNCTION__"');
    
    // Evaluate the object (safer than using eval)
    const enLocale = Function(`return ${enJsonStr}`)();

    // Process each non-English locale
    for (const localePath of localeFiles) {
      if (localePath === enLocalePath) continue;

      const localeCode = path.basename(localePath, '.ts');
      
      // Read locale content
      let localeContent = fs.readFileSync(localePath, 'utf8');
      
      // Extract the locale object
      const localeMatch = localeContent.match(/export\s+default\s+(\{[\s\S]*\})/);
      if (!localeMatch) {
        console.log(`${colors.yellow}Could not parse ${localeCode} locale file${colors.reset}`);
        continue;
      }

      // Convert to proper JSON-like string
      let localeJsonStr = localeMatch[1].replace(/,(\s*[}\]])/g, '$1');
      
      // Handle exporting functions
      localeJsonStr = localeJsonStr.replace(/:\s*\([^)]*\)\s*=>\s*\{[^}]*\}/g, ': "__FUNCTION__"');
      
      // Evaluate the object
      const locale = Function(`return ${localeJsonStr}`)();

      // Find missing keys
      const missingKeys = findMissingKeys(enLocale, locale);

      // Report results
      if (missingKeys.length > 0) {
        console.log(`\n${colors.yellow}Locale ${localeCode} is missing ${missingKeys.length} translations:${colors.reset}`);
        missingKeys.forEach(key => console.log(`  ${colors.red}${key}${colors.reset}`));
      } else {
        console.log(`\n${colors.green}Locale ${localeCode} has all translations!${colors.reset}`);
      }
    }
  } catch (error) {
    console.error(`${colors.red}Error comparing locales: ${error.message}${colors.reset}`);
    process.exit(1);
  }
}

// Run the comparison
compareLocales();