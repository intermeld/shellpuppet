import * as fs from 'node:fs';
import process from 'node:process';

fs.writeFileSync(process.env['SP_TEST_SPAWN_MARKER'], String(process.pid));
await import('../../../dist/daemon/index.js');
