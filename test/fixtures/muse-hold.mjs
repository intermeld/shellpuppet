// Draw a captured Muse approval screen and keep the menu waiting.
import { readFileSync } from 'node:fs';

process.stdout.write(readFileSync(process.argv[2], 'utf8'));
setInterval(() => {}, 200);
