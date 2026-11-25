'use strict';
// Stand-in for Node core modules that have no meaning in the sandbox (child_process, ...).
// Loading succeeds (packages often require them eagerly); using them throws.
module.exports = new Proxy({}, { get: (_, k) => (typeof k === 'symbol' || k === 'then' ? undefined : () => { throw new Error('core module function ' + String(k) + '() is not available in the sandbox'); }) });
