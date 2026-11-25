// Entry of the lazily loaded transformer script (dist/site/esm-transform.js). The kernel worker pulls it in
// with importScripts the first time it meets an ES module that has no precompiled form.
import { transformEsm } from './transform.js'
;(globalThis as unknown as { __bhEsmTransform: typeof transformEsm }).__bhEsmTransform = transformEsm
