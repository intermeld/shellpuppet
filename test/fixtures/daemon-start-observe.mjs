import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const home = process.env.SHELLPUPPET_HOME;
const [node, launcher] = process.argv.slice(2);
if (node) {
  const proof = process.env.SHELLPUPPET_DAEMON_START_ID.split('.');
  const privateValues = [home, ...proof].map(value => value.toLowerCase());
  const clean = process.argv.every(arg => privateValues.every(value => !arg.toLowerCase().includes(value)));
  writeFileSync(path.join(home, 'private-argv'), String(clean));
  const child = spawnSync(node, [launcher, '--daemon-entry', fileURLToPath(import.meta.url)], {
    env: { ...process.env, SP_EXPECTED_TEST_HOME: home }, windowsHide: true, stdio: 'ignore',
  });
  process.exitCode = child.status ?? 1;
} else {
  writeFileSync(path.join(home, 'same-home'), String(home === process.env.SP_EXPECTED_TEST_HOME));
  if (existsSync(path.join(home, 'notify-progress'))) process.send?.({ progress: 'starting' });
  await import('../../dist/daemon/index.js');
}
