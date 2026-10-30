/**
 * Integration tests exercise the COMPILED daemon (spawned detached, exactly as
 * production clients do), so dist/ must be current before they run.
 */

import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';

export default function globalSetup(): void {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  execSync('npm run build', { cwd: root, stdio: 'inherit' });
}
