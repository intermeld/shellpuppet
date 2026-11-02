import { writeFileSync } from 'node:fs';

const [mode, marker] = process.argv.slice(2);
writeFileSync(marker, String(process.pid));
if (mode === 'hang') setInterval(() => undefined, 1_000);
