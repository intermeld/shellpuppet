import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { desktopEntry, installDesktopShortcut, parseShellLink, shellLink, uninstallDesktopShortcut } from '../../src/cli/desktopShortcut.js';

const folders: string[] = [];
afterEach(() => { for (const folder of folders.splice(0)) fs.rmSync(folder, { recursive: true, force: true }); });
function folder(): string { const value = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-shortcut-')); folders.push(value); return value; }

describe('desktop shortcut', () => {
  it('round trips the published Shell Link fields', () => {
    const fields = { target: 'C:\\Program Files\\nodejs\\node.exe', arguments: '"C:\\Apps\\ShellPuppet\\dist\\cli\\index.js" desktop', workingDirectory: 'C:\\Users\\Example', icon: 'C:\\Apps\\ShellPuppet\\icon.ico', description: 'Start ShellPuppet', showCommand: 7 };
    expect(parseShellLink(shellLink(fields))).toEqual(fields);
  });

  it('installs, updates and removes only its Start menu link', () => {
    const dir = folder();
    const fields = { target: 'C:\\node.exe', arguments: '"C:\\pkg\\cli.js" desktop', workingDirectory: 'C:\\Users\\Example', icon: 'C:\\pkg\\icon.ico', description: 'Start ShellPuppet', showCommand: 7 };
    fs.writeFileSync(path.join(dir, 'Someone Else.lnk'), 'keep');
    installDesktopShortcut({ platform: 'win32', applicationsDir: dir, fields });
    const link = path.join(dir, 'ShellPuppet.lnk');
    expect(parseShellLink(fs.readFileSync(link))).toEqual(fields);
    const updated = { ...fields, arguments: '"C:\\pkg-new\\cli.js" desktop' };
    installDesktopShortcut({ platform: 'win32', applicationsDir: dir, fields: updated });
    expect(parseShellLink(fs.readFileSync(link))).toEqual(updated);
    uninstallDesktopShortcut({ platform: 'win32', applicationsDir: dir });
    expect(fs.existsSync(link)).toBe(false);
    expect(fs.readFileSync(path.join(dir, 'Someone Else.lnk'), 'utf8')).toBe('keep');
  });

  it('writes a Linux desktop launcher with an icon and no terminal', () => {
    const dir = folder();
    const fields = { target: '/usr/bin/node', arguments: '"/opt/shellpuppet/dist/cli/index.js" desktop', workingDirectory: '/home/example', icon: '/opt/shellpuppet/icon-512.png', description: 'Start ShellPuppet', showCommand: 7 };
    installDesktopShortcut({ platform: 'linux', applicationsDir: dir, fields });
    expect(fs.readFileSync(path.join(dir, 'shellpuppet.desktop'), 'utf8')).toBe(desktopEntry(fields));
    expect(desktopEntry(fields)).toContain('Terminal=false');
    expect(desktopEntry(fields)).toContain('Exec=/usr/bin/node "/opt/shellpuppet/dist/cli/index.js" desktop');
    uninstallDesktopShortcut({ platform: 'linux', applicationsDir: dir });
    expect(fs.existsSync(path.join(dir, 'shellpuppet.desktop'))).toBe(false);
  });

  it('escapes desktop entry strings and reserved Exec characters', () => {
    const fields = { target: '/opt/100% $bin\\node', arguments: '"/opt/a%f/cli.js" desktop',
      workingDirectory: '/home/a\\b\nnext\tpart\rend', icon: '/opt/a\\b\nicon.png',
      description: 'First\\second\nthird\tfourth\rfifth', showCommand: 7 };
    const entry = desktopEntry(fields);
    expect(entry).toContain(String.raw`Exec="/opt/100%% \\$bin\\\\node" "/opt/a%%f/cli.js" desktop`);
    expect(entry).toContain('Path=/home/a\\\\b\\nnext\\tpart\\rend\n');
    expect(entry).toContain('Icon=/opt/a\\\\b\\nicon.png\n');
    expect(entry).toContain('Comment=First\\\\second\\nthird\\tfourth\\rfifth\n');
    expect(entry).toContain('Name=ShellPuppet\n');
  });
});
