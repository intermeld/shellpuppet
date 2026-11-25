import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { env } from 'node:process';

// Each byte counts one input body encoded in this client process.
const counter = join(env.SHELLPUPPET_HOME, 'input-serialisations');
const stringify = JSON.stringify;
JSON.stringify = function (value, ...args) {
  if (typeof value?.data === 'string') appendFileSync(counter, '1');
  return stringify(value, ...args);
};
