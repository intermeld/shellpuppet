import { describe, expect, it } from 'vitest';
import { detectPrompt } from '../../src/core/promptDetector.js';

const VOICE = `── Voice input (Alt+V to start) ${'─'.repeat(60)}`;
const STATUS = '  muse-wonder-1.0 · high · C:\\work\\project · Launch overrides';

/** The tool-action approval Muse Code 1.4.23 draws in place of its composer. */
const menu = [
  'Would you like to allow this tool action?',
  '',
  '  tool action: mcp__example__send_message',
  'Reviewer: a one-line reason from the approval reviewer',
  '⟩ 1. Yes, proceed (y)',
  "  2. Yes, don't ask again this session (p)  tool `mcp__example__send_message`",
  '  3. Always allow this MCP tool  tool `mcp__example__send_message`',
  '  4. No, and tell Muse Code what to do differently (esc)',
  'Change approval defaults in /permissions',
];

function screen(rows: string[]): string {
  return [...Array<string>(6).fill(''), ...rows].join('\n');
}

describe('Muse Code tool-action approval', () => {
  it('is a waiting prompt with all four choices', () => {
    const prompt = detectPrompt(screen([
      '❯ please send the result to the other chair',
      '◈ Calling tools (2m 09s · esc to interrupt)',
      '└ last event 50s ago',
      VOICE, ...menu, '─'.repeat(60), STATUS,
    ]), 'muse', 24);
    expect(prompt?.question).toBe('Would you like to allow this tool action?');
    expect(prompt?.options).toHaveLength(4);
    expect(prompt?.selectedOption).toBe(0);
    expect(prompt?.options[3]).toContain('No, and tell Muse Code what to do differently');
  });

  it('follows the selection to a later choice', () => {
    const moved = menu.map((row) => row.startsWith('⟩ 1.') ? row.replace('⟩ ', '  ')
      : row.startsWith('  4.') ? row.replace(/^ {2}/, '⟩ ') : row);
    const prompt = detectPrompt(screen([VOICE, ...moved, '─'.repeat(60), STATUS]), 'muse', 24);
    expect(prompt?.selectedOption).toBe(3);
  });

  it('is not a prompt once it was answered and the transcript moved on', () => {
    expect(detectPrompt(screen([
      VOICE, ...menu, '◆ session_send · ✓ · 1m', '◆ Sent the line.', VOICE, '❯', '─'.repeat(60), STATUS,
    ]), 'muse', 24)).toBeNull();
  });
});
