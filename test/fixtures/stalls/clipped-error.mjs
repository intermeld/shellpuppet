import { requestFailed } from './request-failed.mjs';

const red = text => `\x1b[48;2;20;20;20m\x1b[38;2;251;113;133m${text}\x1b[0m`;

// Only a neutral JSON body remains in the viewport; its marker is above it.
export function clippedError({ cols = 80, draft = '', busy = false, laterTurn = false,
  redGutter = true, recover = true } = {}) {
  const source = requestFailed({ cols, wrappedChrome: false, draft, busy, recover });
  const footer = source.indexOf('\r\n     \x1b[38;2;251;129;71m▣  ');
  if (footer < 0) throw new Error('Fixture footer missing');
  const gutter = text => `  ${redGutter ? red('┃') : '┃'}     ${text}`;
  const body = [
    gutter('{'),
    gutter('  "example": "invalid",'),
    gutter('  "details": ['),
    gutter('    "first example",'),
    gutter('    "second example"'),
    gutter('  ],'),
    gutter('  "code": "sample"'),
    gutter('}'),
    gutter('More neutral validation detail.'),
    `  ${redGutter ? red('┃') : '┃'}`,
  ];
  if (laterTurn) body.push('  \x1b[38;2;255;128;64m┃\x1b[0m  Continue the example.', '     A newer answer.');
  return '\x1b[2J\x1b[H' + body.join('\r\n') + '\r\n\r\n' + source.slice(footer + 2);
}
