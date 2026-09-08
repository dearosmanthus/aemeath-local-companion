'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { validateLocalConfig } = require('../lib/companion-network');
try {
  validateLocalConfig(JSON.parse(fs.readFileSync(path.join(__dirname, '../config.json'), 'utf8')));
} catch (error) {
  // The validator reports field names, never their secret-looking values.
  console.error(error instanceof SyntaxError ? 'Invalid companion config.json.' : error.message);
  process.exitCode = 1;
}
