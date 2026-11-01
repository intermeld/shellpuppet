/**
 * Integration tests exercise the COMPILED daemon (spawned detached, exactly as
 * production clients do), so dist/ must be current before they run.
 */

import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

export default function globalSetup(): void {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  execFileSync(process.execPath, [path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'),
    '-p', 'tsconfig.build.json'], { cwd: root, stdio: 'inherit' });
  execFileSync(process.execPath, [path.join(root, 'scripts', 'copy-viewer-assets.mjs')],
    { cwd: root, stdio: 'inherit' });
}
