/**
 * A stand-in for a daemon that is alive but slow to answer. It listens on an
 * ephemeral loopback port, prints `{ port, pid }` as one JSON line and answers
 * `/health` only after a delay, or never.
 *
 * Usage: node slow-health.mjs <delay-ms | never> <other: destroy | answer | vanish>
 * - `destroy`: any other request has its connection destroyed, as when a
 *   daemon drops a request mid-flight;
 * - `answer`: any other request gets `{ "from": <pid> }`;
 * - `vanish`: any other request makes it stop listening and drop the
 *   request, as a daemon that is stopping does: its process lives on, its
 *   port refuses.
 */

import * as http from 'node:http';
import process from 'node:process';
import { setInterval, setTimeout } from 'node:timers';

const delay = process.argv[2] ?? 'never';
const other = process.argv[3] ?? 'destroy';

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    if (delay === 'never') return; // The request is held open.
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, version: '0.0.0-stand-in', pid: process.pid }));
    }, Number(delay));
    return;
  }
  if (other === 'answer') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ from: process.pid }));
    return;
  }
  if (other === 'vanish') {
    server.close();
    server.closeAllConnections();
    setInterval(() => undefined, 1_000); // The process lives on until ended.
    return;
  }
  req.socket.destroy();
});

server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  process.stdout.write(`${JSON.stringify({ port: address.port, pid: process.pid })}\n`);
});
