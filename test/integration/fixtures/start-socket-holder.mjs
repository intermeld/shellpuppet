import * as fs from 'node:fs';
import * as net from 'node:net';
import process from 'node:process';

const server = net.createServer((socket) => socket.destroy());
server.listen(process.argv[2], () => fs.writeFileSync(process.argv[3], 'ready'));
