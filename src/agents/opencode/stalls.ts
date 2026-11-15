import type { StallSignature } from '../types.js';

// OpenCode's centred connection banner remains visible above a frozen busy row.
// MiMo Code shares the same underlying terminal interface.
export const serverLost: StallSignature = {
  reason: 'server-lost',
  description: 'The local agent server connection was lost.',
  marker: { text: /^ {2}┃ {15,}[⠀-⣿] Connection lost…$/u, fg: ['#eeeeee'] },
  overlay: { message: { text: '^ {2}┃ {15,}Reconnecting to the server automatically\\.$' }, background: '#141414', centreOffset: -1 },
  frameColumns: [2, 16, 18],
  chrome: [], before: { text: '$^' }, rows: [], footer: { text: '$^' },
  composer: { text: '$^' }, idle: [], bottom: [],
};

export const stalls: StallSignature[] = [serverLost];
