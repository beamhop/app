'use strict';
module.exports = {
  URL,
  URLSearchParams: typeof URLSearchParams === 'undefined' ? undefined : URLSearchParams,
  fileURLToPath: (u) => decodeURIComponent(new URL(u).pathname),
  pathToFileURL: (p) => new URL('file://' + p),
};
