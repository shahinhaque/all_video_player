import { defineConfig } from 'vitest/config';

export default defineConfig({
  define: {
    __TARGET__: JSON.stringify('chrome'),
    __DEV__: 'true',
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
