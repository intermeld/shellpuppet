import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AGENT_MODULES } from '../../src/agents/index.js';
import { detectPrompt } from '../../src/core/promptDetector.js';
import { useDialogSignatures } from '../../src/core/dialogs.js';

const fixture = (name: string): string => fs.readFileSync(path.join(__dirname, '..', 'fixtures', name), 'utf8');

afterEach(() => { useDialogSignatures([]); });

describe('prompt shapes by resolved agent', () => {
  it.each(['opencode', 'mimo'])('runs %s menus and the shared generic detector', (agent) => {
    expect(detectPrompt(fixture('dialogs/mimo-question-menu.txt'), agent)?.options).toContain('Type your own answer');
    expect(detectPrompt(fixture('dialogs/opencode-permission-dialog.txt'), agent)?.question).toContain('Permission required');
    expect(detectPrompt('Continue? (y/n)', agent)?.question).toBe('Continue? (y/n)');
    expect(detectPrompt('Press enter to continue', agent)?.basis).toBe('frame');
  });

  it.each([...AGENT_MODULES.map(module => module.name), 'custom'])('runs every module shape for %s', (agent) => {
    for (const name of ['dialogs/mimo-question-menu.txt', 'dialogs/opencode-permission-dialog.txt', 'muse-live-129-menu.txt']) {
      expect(detectPrompt(fixture(name), agent), name).toEqual(detectPrompt(fixture(name)));
      expect(detectPrompt(fixture(name), agent), name).not.toBeNull();
    }
  });

  it('keeps configured dialogs available alongside every module', () => {
    useDialogSignatures([{ name: 'custom', title: '^Custom permission', choices: '^Accept {2,}Reject' }]);
    for (const module of AGENT_MODULES) {
      expect(detectPrompt('Custom permission\nAccept  Reject', module.name)?.options).toEqual(['Accept', 'Reject']);
    }
  });
});
