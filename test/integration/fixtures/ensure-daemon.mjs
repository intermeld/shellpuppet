/**
 * Test fixture: behave exactly like a real one-shot client. Ensure the daemon
 * (auto-starting it detached if absent), print where it lives, exit.
 *
 * The parent test asserts this process EXITS PROMPTLY. If the daemon spawn
 * ever inherits stdio, this process's pipes stay open and the parent hangs:
 * the inherited-stdio hang (design §2.2).
 *
 * It exits by letting its event loop DRAIN, and deliberately never calls
 * `process.exit`. A forced exit leaves whether the daemon was detached
 * untested: `ensureDaemon` also has to `unref()` the child it spawned, or
 * the handle keeps this process alive for as long as the daemon runs, and a
 * `process.exit(0)` here would hide exactly that. Draining is also what a
 * real one-shot client does.
 */

import process from 'node:process';
import { ensureDaemon } from '../../../dist/client/http.js';

const connection = await ensureDaemon();
process.stdout.write(
  JSON.stringify({
    port: connection.port,
    version: connection.version,
    tokenPrefix: connection.token.slice(0, 8),
    warnings: connection.warnings,
  }),
);
