import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['apps/**/*.test.ts', 'packages/**/*.test.ts', 'tests/**/*.test.ts'], exclude: ['**/node_modules/**', '**/dist/**', '**/e2e/**'], testTimeout: 15000 } });
