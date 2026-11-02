import { ensureDaemon } from '../../../dist/client/http.js';
import process from 'node:process';

try {
  await ensureDaemon({ wrappedStartTimeoutMs: Number(process.argv[2]),
    ...(process.argv[3] === undefined ? {} : { direct: true, daemonEntry: process.argv[3] }) });
  process.stdout.write('healthy');
} catch (error) {
  process.stderr.write(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
