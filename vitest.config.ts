import { defineConfig } from 'vitest/config'
// packages/{proxy,sandbox,tls} are being built and are not in the npm workspace yet, so CI has not
// installed their dependencies. Their tests run from inside each package until they are wired in.
const pending = process.env.BH_TEST_PENDING ? [] : ['packages/{proxy,sandbox,tls}/**']
export default defineConfig({ test: { include: ['packages/*/test/**/*.test.ts'], exclude: ['**/node_modules/**', ...pending], environment: 'node', setupFiles: ['tools/vitest-setup.ts'] } })
