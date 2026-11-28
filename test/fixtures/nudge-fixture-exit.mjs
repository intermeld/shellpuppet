import { existsSync } from 'node:fs';
import { join } from 'node:path';

// These recording programmes have no more work after the test's final assertion.
const finished = join(process.env.SHELLPUPPET_HOME, 'nudge-fixture-finished');
setInterval(() => { if (existsSync(finished)) process.exit(0); }, 100).unref();
