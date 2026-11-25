// Worker thread: ESM source -> System.register form (Babel).
import { parentPort } from 'node:worker_threads';
import * as babel from '@babel/core';
import systemjsMod from '@babel/plugin-transform-modules-systemjs';
const systemjs = systemjsMod.default || systemjsMod;
import dynMod from '@babel/plugin-transform-dynamic-import';
const dynamicImport = dynMod.default || dynMod;

parentPort.on('message', ({ id, code, filename }) => {
  try {
    if (code.startsWith('#!')) code = '//' + code;
    const out = babel.transformSync(code, {
      babelrc: false, configFile: false, sourceType: 'module', filename, compact: true, comments: false, sourceMaps: false,
      parserOpts: { plugins: ['importAttributes', 'explicitResourceManagement'], allowReturnOutsideFunction: true },
      plugins: [dynamicImport, [systemjs, { allowTopLevelThis: true }]],
    });
    parentPort.postMessage({ id, code: out.code });
  } catch (e) {
    parentPort.postMessage({ id, error: String(e && e.message || e).slice(0, 500) });
  }
});
