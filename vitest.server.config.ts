import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['tests/suwayomi.integration.ts'], environment: 'node', setupFiles: ['tests/setup.ts'], testTimeout: 180000 } });
