/**
 * Build step: copy the static viewer assets into dist/, alongside the compiled
 * daemon that serves them. tsc only emits TypeScript.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'src', 'viewer');
const target = path.join(root, 'dist', 'viewer');

fs.mkdirSync(target, { recursive: true });
for (const name of fs.readdirSync(source)) {
  fs.copyFileSync(path.join(source, name), path.join(target, name));
}
