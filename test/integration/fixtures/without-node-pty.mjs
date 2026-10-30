/**
 * Preload (`node --import`) for a daemon started as if node-pty were not
 * installed. Both ways of loading it fail the way a missing package does: an
 * import through the ESM resolver, and a require through the CommonJS loader.
 * Every other module loads as usual.
 */

import { createRequire, register } from 'node:module';

const resolveHook = `export async function resolve(specifier, context, next) {
  if (specifier === 'node-pty') {
    const error = new Error("Cannot find package 'node-pty'");
    error.code = 'ERR_MODULE_NOT_FOUND';
    throw error;
  }
  return next(specifier, context);
}`;
register(`data:text/javascript,${encodeURIComponent(resolveHook)}`);

const Module = createRequire(import.meta.url)('node:module');
const load = Module._load;
Module._load = function loadWithoutNodePty(request, ...rest) {
  if (request === 'node-pty') {
    const error = new Error("Cannot find module 'node-pty'");
    error.code = 'MODULE_NOT_FOUND';
    throw error;
  }
  return load.call(this, request, ...rest);
};
