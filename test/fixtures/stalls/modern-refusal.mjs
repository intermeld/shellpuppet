// Synthetic MiMo screen. All transcript, file, project and model details are neutral.
const ink = (rgb, text) => `\x1b[38;2;${rgb}m${text}\x1b[0m`;
const orange = text => ink('251;129;71', text);
const user = text => ink('255;128;64', text);
const red = text => ink('251;113;133', text);
const dark = text => ink('10;10;10', text);
const grey = text => ink('128;128;128', text);
const plainLength = value => value.replace(/\x1b\[[0-9;]*m/g, '').length;

export function modernRefusal({ cols = 96, suggestion = true, highRisk = true,
  panel = true, footer = 'new', fullWidthChrome = false, visibleTurn = true } = {}) {
  const rows = [
    ...(visibleTurn ? [`  ${user('┃')}  Review the sample.`, '', '     Neutral task output.', ''] : []),
  ];
  if (panel) rows.push(
    `  ${dark('┃')}  Sample tool output`,
    `  ${dark('┃')}`,
    `  ${dark('┃')}      Example record`,
    `  ${dark('┃')}`,
    `  ${dark('┃')}      Example summary`,
    `  ${dark('┃')}`,
    `  ${dark('┃')}      Example note`,
    `  ${dark('┃')}`,
    `  ${dark('┃')}`,
    `  ${dark('┃')}  ${grey('Click to expand')}`,
    `  ${dark('┃')}`,
    '',
  );
  if (highRisk) rows.push('     The request was rejected because it was considered high risk', '');
  rows.push(
    `  ${red('┃')}`,
    `  ${red('┃')}     ${red('✗ Error')}`,
    `  ${red('┃')}`,
    `  ${red('┃')}     The response was withheld by the model provider's content safety filter.`,
    `  ${red('┃')}`,
    '',
  );
  const footerRow = rows.length;
  rows.push(`     ${orange('▣  ')}Build ${grey('· Example Model · 18m 59s')}` +
    '          ' + grey('↻ /recover') + '          ' + grey('⎘ copy') + `  ${dark('▄')}`);
  rows.push('');
  rows.push(`  ${orange('┃')}`);
  rows.push(suggestion ? `  ${orange('┃')}  ${grey('Review the sample task. (Tab to')}` : `  ${orange('┃')}`);
  rows.push(`  ${orange('┃')}`);
  rows.push(`  ${orange('┃')}  ${orange('Build')} · Example Model Example Co`);
  rows.push(`  ${orange('╹')}${ink('30;30;30', '▀'.repeat(Math.max(20, cols - 5)))}`);
  rows.push(footer === 'new'
    ? `   ${grey('42.1K/661K↓ (6%) · $0.01')}  tab ${grey('switch')}    ctrl+p          @ ${grey('attach file')}$ ${grey('subagent')}  / ${grey('commands')}`
    : '   ctrl+p settings');
  if (footer === 'new') rows.push('                              mode          settings');
  let output = '\x1b[2J\x1b[H';
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const padded = fullWidthChrome && i >= footerRow
      ? row + ' '.repeat(Math.max(0, cols - plainLength(row))) : row;
    output += padded + (i < rows.length - 1 ? (fullWidthChrome && i >= footerRow ? '' : '\r\n') : '');
  }
  return output;
}
