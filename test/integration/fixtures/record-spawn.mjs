/**
 * Stands in for the daemon entry point when a test needs to know whether a
 * client started a daemon at all: it records its pid in `spawned` under the
 * home it was given, then exits without starting anything.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import process from 'node:process';

const home = process.env['SHELLPUPPET_HOME'];
if (home) fs.writeFileSync(path.join(home, 'spawned'), String(process.pid));
