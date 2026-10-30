/**
 * Stands in for the daemon entry point when a test needs to know the working
 * directory a client starts the daemon in. It records `process.cwd()` in
 * `spawned-cwd` under the home it was given, then answers `/health` and
 * publishes `daemon.json` as a daemon does, so the client's start succeeds
 * at once. It exits after twenty seconds if nothing has ended it.
 */

import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import process from 'node:process';
import { setTimeout } from 'node:timers';

const home = process.env['SHELLPUPPET_HOME'];
if (!home) process.exit(1);
fs.writeFileSync(path.join(home, 'spawned-cwd'), process.cwd());

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, version: '0.0.0-stand-in', pid: process.pid }));
});
server.listen(0, '127.0.0.1', () => {
  const { port } = server.address();
  fs.writeFileSync(
    path.join(home, 'daemon.json'),
    JSON.stringify({
      port,
      token: 'stand-in-token',
      pid: process.pid,
      version: '0.0.0-stand-in',
      startedAt: new Date().toISOString(),
    }),
  );
});
setTimeout(() => process.exit(0), 20_000);
