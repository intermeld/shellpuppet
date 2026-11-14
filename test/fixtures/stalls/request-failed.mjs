// Synthetic screen with neutral task, output, model and failure details.
const ink = (rgb, text) => `\x1b[38;2;${rgb}m${text}\x1b[0m`;
const orange = text => ink('251;129;71', text);
const user = text => ink('255;128;64', text);
const red = text => ink('251;113;133', text);
const grey = text => ink('128;128;128', text);
const dark = text => ink('30;30;30', text);
const plainLength = value => value.replace(/\x1b\[[0-9;]*m/g, '').length;

export function requestFailed({ cols = 80, suggestion = false, duration = false, recover = true,
  trailingGlyph = true, status = 400, retryable = false, failure = 'Example connection closed.', wrappedChrome = cols === 80,
  draft = '', laterTurn = false, toolOpen = false, quoted = false, busy = false } = {}) {
  const marker = `✗ Error · status ${status} · ${retryable ? 'retryable' : 'non-retryable'}`;
  const rows = [
    `  ${user('┃')}  Summarise the example.`,
    '', '     Neutral sample output.', '     A second neutral line.', '',
    ...(quoted ? ['     ```text', `     ${marker}`, `     Request failed: ${failure}`, '     ```', ''] : []),
    '     Example result.', '',
    ...(toolOpen ? [`  ${ink('10;10;10', '┃')}  Example tool output`] : []),
    `  ${red('┃')}`,
    `  ${red('┃')}     ${red('✗ Error')}${grey(` · status ${status} · ${retryable ? 'retryable' : 'non-retryable'}`)}`,
    `  ${red('┃')}`,
    `  ${red('┃')}     Request failed: ${failure}`,
    `  ${red('┃')}`,
    '',
  ];
  if (laterTurn) rows.push(`  ${user('┃')}  Continue the example.`, '', '     New result.', '');
  const footerRow = rows.length;
  const footer = `     ${orange('▣  ')}Build ${grey(`· Example Model${duration ? ' · 3s' : ''}`)}`;
  rows.push(footer +
    (recover ? ' '.repeat(Math.max(1, cols - 15 - plainLength(footer))) + grey('↻ /recover') : '') +
    (trailingGlyph ? `  ${dark('▄')}` : ''));
  if (busy) rows.push('   esc to interrupt');
  rows.push('');
  rows.push(`  ${orange('┃')}`);
  rows.push(draft ? `  ${orange('┃')}  ${draft}` : suggestion
    ? `  ${orange('┃')}  ${grey('Review the example. (Tab to')}` : `  ${orange('┃')}`);
  rows.push(`  ${orange('┃')}`);
  rows.push(`  ${orange('┃')}  ${orange('Build')} · Example Model`);
  rows.push(`  ${orange('╹')}${dark('▀'.repeat(Math.max(20, cols - 5)))}`);
  if (cols === 80) rows.push(
    `   ${grey('108.4K/661K↓ (16%) · $0.09')}  tab      ctrl+p    @ attach   $        /`,
    '                               switch   settings  file       subagent commands',
    '                               mode',
  );
  else rows.push(
    `   ${grey('42.1K/661K↓ (6%) · $0.01')}  tab switch    ctrl+p          @ attach file$ subagent  / commands`,
    '                              mode          settings',
  );
  let output = '\x1b[2J\x1b[H';
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    output += wrappedChrome && i >= footerRow ? row + ' '.repeat(Math.max(0, cols - plainLength(row))) : row;
    if (i < rows.length - 1 && (!wrappedChrome || i < footerRow)) output += '\r\n';
  }
  return output;
}
