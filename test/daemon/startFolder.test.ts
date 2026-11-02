import { describe, expect, it } from 'vitest';
import { shortFolderProblem, temporaryParentProblem, type FolderFacts } from '../../src/client/http.js';

const ME = 501;
const SOMEONE_ELSE = 502;

function facts(kind: 'dir' | 'link' | 'file', uid: number, mode: number): FolderFacts {
  return {
    isDirectory: () => kind === 'dir',
    isSymbolicLink: () => kind === 'link',
    uid,
    mode,
  };
}

describe('the temporary folder that holds the short start socket folder', () => {
  it('accepts /tmp, a private per-user folder and a root folder only others cannot write to', () => {
    expect(temporaryParentProblem(facts('dir', 0, 0o1777), ME)).toBeNull();
    expect(temporaryParentProblem(facts('dir', ME, 0o700), ME)).toBeNull();
    expect(temporaryParentProblem(facts('dir', 0, 0o755), ME)).toBeNull();
    expect(temporaryParentProblem(facts('dir', ME, 0o1777), ME)).toBeNull();
  });

  it('refuses a sticky folder owned by another user, who could still rename entries in it', () => {
    expect(temporaryParentProblem(facts('dir', SOMEONE_ELSE, 0o1777), ME)).toBe('temporary folder belongs to another user');
    expect(temporaryParentProblem(facts('dir', SOMEONE_ELSE, 0o755), ME)).toBe('temporary folder belongs to another user');
  });

  it('refuses a shared folder without the sticky bit, whoever owns it', () => {
    expect(temporaryParentProblem(facts('dir', ME, 0o777), ME)).toBe('temporary folder is shared without the sticky bit');
    expect(temporaryParentProblem(facts('dir', 0, 0o775), ME)).toBe('temporary folder is shared without the sticky bit');
  });

  it('refuses a link or a file', () => {
    expect(temporaryParentProblem(facts('link', ME, 0o777), ME)).toBe('temporary folder is not a real folder');
    expect(temporaryParentProblem(facts('file', ME, 0o600), ME)).toBe('temporary folder is not a real folder');
  });
});

describe('the short start socket folder', () => {
  it('accepts only a real folder of this user with no access for others', () => {
    expect(shortFolderProblem(facts('dir', ME, 0o700), ME)).toBeNull();
  });

  it('names each refused case by its own guard', () => {
    expect(shortFolderProblem(facts('link', ME, 0o700), ME)).toBe('short folder is a link');
    expect(shortFolderProblem(facts('file', ME, 0o700), ME)).toBe('short folder is not a real folder');
    expect(shortFolderProblem(facts('dir', SOMEONE_ELSE, 0o700), ME)).toBe('short folder belongs to another user');
    expect(shortFolderProblem(facts('dir', ME, 0o755), ME)).toBe('short folder is open to others');
    expect(shortFolderProblem(facts('dir', ME, 0o707), ME)).toBe('short folder is open to others');
  });
});
