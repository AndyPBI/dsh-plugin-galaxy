import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  // Client components are `.tsx` and the client tsconfig sets `jsx: react-jsx`.
  // Vitest reads the ROOT tsconfig (which excludes src/client and has no `jsx`),
  // so without this the sources compile with the classic transform and throw
  // "React is not defined" at render time.
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'react',
  },
  resolve: {
    alias: {
      // Host-injected at runtime, not an npm dependency of this package.
      '@deepseek-ai/dsh-client-ui-primitives': fileURLToPath(
        new URL('./tests/stubs/primitives.ts', import.meta.url),
      ),
      // An OPTIONAL peer dependency that only a real DSH host provides; the
      // stub stands in so the settings-namespace contract stays testable here
      // (it is loaded lazily, so the alias is what an installed host does for
      // real). See tests/settings.test.ts.
      '@deepseek-ai/schemastery': fileURLToPath(
        new URL('./tests/stubs/schemastery.ts', import.meta.url),
      ),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20_000,
  },
})
