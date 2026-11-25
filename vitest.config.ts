import { defineConfig } from 'vitest/config'
// packages/sandbox is being built and is not in the npm workspace yet, so CI has not
// installed its dependencies. Its tests run from inside the package until it is wired in.
const pending = process.env.BH_TEST_PENDING ? [] : ['packages/sandbox/**']
export default defineConfig({ test: { include: ['packages/*/test/**/*.test.ts'], exclude: ['**/node_modules/**', ...pending], environment: 'node', setupFiles: ['tools/vitest-setup.ts'] } })
