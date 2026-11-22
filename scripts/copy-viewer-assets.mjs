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
// An incremental build must not package the retired runtime-compiled helper.
for (const name of ['windowsLiveMetadata.cs', 'windowsLiveMetadata.js', 'windowsLiveMetadata.js.map',
  'windowsLiveMetadata.d.ts']) {
  fs.rmSync(path.join(root, 'dist', 'core', name), { force: true });
}
for (const base of ['liveResumeIds', 'posixProcesses']) {
  for (const extension of ['.js', '.js.map', '.d.ts']) {
    fs.rmSync(path.join(root, 'dist', 'daemon', base + extension), { force: true });
  }
}
