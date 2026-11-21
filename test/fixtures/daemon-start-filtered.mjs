import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [program, ...args] = process.argv.slice(2);
if (program) {
  const env = {
    SystemRoot: process.env.SystemRoot,
    SHELLPUPPET_DAEMON_STARTED_WRAPPED: '1',
    SP_FILTER_TEST: 'from-wrapper',
  };
  const child = spawnSync(program, [...args, '--daemon-entry', fileURLToPath(import.meta.url)], {
    env, windowsHide: true, stdio: 'ignore',
  });
  process.exitCode = child.status ?? 1;
} else {
  // A direct retry would succeed at health with the wrong environment.
  if (process.env.SP_FILTER_TEST !== 'from-wrapper' || process.env.SHELLPUPPET_DAEMON_START_ID) process.exit(1);
  writeFileSync(path.join(process.env.SHELLPUPPET_HOME, 'filtered-entry-ran'), '');
  await import('../../dist/daemon/index.js');
}
