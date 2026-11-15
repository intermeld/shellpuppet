const bg = '\x1b[48;2;20;20;20m';
const light = '\x1b[38;2;238;238;238m';
const grey = '\x1b[38;2;128;128;128m';
const reset = '\x1b[0m';

export function serverLost({ cols = 80, rows = 24, banner = true, quoted = false, fileOutput = false,
  typed = false, styled = true, shifted = false, spinner = '⠸' } = {}) {
  const lines = Array.from({ length: rows }, () => '');
  lines[2] = '  ┃  Summarise a neutral sample.';
  lines[5] = '     Example answer in progress.';
  const left = Math.floor(cols / 2) - 24 + (shifted ? 8 : 0);
  const titleRow = Math.floor(rows / 2) - 1;
  const prefix = `  ┃${' '.repeat(left - 3)}`;
  const title = `${spinner} Connection lost…`;
  const detail = 'Reconnecting to the server automatically.';
  if (quoted) {
    lines[6] = `     ${title}`;
    lines[7] = `     ${detail}`;
  }
  if (fileOutput) {
    lines[6] = '     Example file contents:';
    lines[7] = `     ${title}`;
    lines[8] = `     ${detail}`;
  }
  if (banner) {
    lines[titleRow] = `${prefix}${styled ? bg : ''}  ${styled ? light : ''}${title}${reset}`;
    lines[titleRow + 1] = '';
    lines[titleRow + 2] = `${prefix}${styled ? bg : ''}  ${styled ? grey : ''}${detail}${reset}`;
    lines[titleRow + 3] = `${prefix}${styled ? bg : ''}${' '.repeat(48)}${reset}Example status`;
  }
  if (typed) lines[rows - 5] = `  ┃  ${title}`;
  lines[rows - 4] = `  ┃${typed ? `  ${detail}` : ''}`;
  lines[rows - 3] = `  ╹${'▀'.repeat(cols - 4)}`;
  lines[rows - 2] = '   ⬝⬝■■■■■■ esc interrupt       12K (5%)  ctrl+p commands';
  return '\x1b[2J\x1b[H' + lines.join('\r\n');
}
