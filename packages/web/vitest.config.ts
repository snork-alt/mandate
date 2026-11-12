import { defineConfig } from 'vitest/config';

// Component tests opt in to the DOM with a `// @vitest-environment jsdom` pragma.
export default defineConfig({ test: { include: ['test/**/*.test.{ts,tsx}'] } });
