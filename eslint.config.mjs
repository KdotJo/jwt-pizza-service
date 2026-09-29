import js from '@eslint/js';
import globals from 'globals';
import { defineConfig, globalIgnores } from 'eslint/config';

export default defineConfig([
  globalIgnores(['coverage/']), // Skip generated coverage files
  // Recommended rules + Node globals
  { files: ['**/*.{js,mjs,cjs}'], plugins: { js }, extends: ['js/recommended'], languageOptions: { globals: globals.node } },
  { files: ['**/*.js'], languageOptions: { sourceType: 'commonjs' } }, // Uses require()
  // Jest globals (test, expect) in test files
  { files: ['**/*.test.js'], languageOptions: { globals: globals.jest } },
]);
