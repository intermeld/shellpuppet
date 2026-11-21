import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const home = process.env.SHELLPUPPET_HOME;
const [program, launcher] = process.argv.slice(2);
if (program) {
  const child = spawnSync(program, [launcher, '--daemon-entry', fileURLToPath(import.meta.url)], {
    stdio: 'ignore', windowsHide: true,
  });
  writeFileSync(path.join(home, 'launcher-exited'), String(child.status));
  process.exitCode = child.status ?? 1;
} else {
  writeFileSync(path.join(home, 'starting-pid'), String(process.pid));
  while (!existsSync(path.join(home, 'allow-health'))) await setTimeout(100);
  await import('../../dist/daemon/index.js');
}
