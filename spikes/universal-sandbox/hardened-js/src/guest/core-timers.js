'use strict';
module.exports = { setTimeout, clearTimeout, setInterval, clearInterval, setImmediate: (fn, ...a) => setTimeout(fn, 0, ...a), clearImmediate: clearTimeout };
