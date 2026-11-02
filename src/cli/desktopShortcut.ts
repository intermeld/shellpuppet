/** Per-user launchers written without a shell or script host. */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface ShortcutFields {
  target: string;
  arguments: string;
  workingDirectory: string;
  icon: string;
  description: string;
  showCommand: number;
}

interface ShortcutOptions {
  platform: NodeJS.Platform;
  applicationsDir: string;
  fields?: ShortcutFields;
}

const LINK_CLSID = Buffer.from('0114020000000000c000000000000046', 'hex');
const FLAGS = 0x02 | 0x04 | 0x10 | 0x20 | 0x40 | 0x80;
const ansi = (value: string): Buffer => Buffer.from(`${value}\0`, 'latin1');
const wide = (value: string): Buffer => Buffer.from(`${value}\0`, 'utf16le');
function stringData(value: string): Buffer {
  const body = Buffer.from(value, 'utf16le');
  if (body.length / 2 > 0xffff) throw new Error('Shortcut text is too long.');
  const size = Buffer.alloc(2);
  size.writeUInt16LE(body.length / 2);
  return Buffer.concat([size, body]);
}

/** MS-SHLLINK: header, local LinkInfo, Unicode StringData and terminal block. */
export function shellLink(fields: ShortcutFields): Buffer {
  if (!path.win32.isAbsolute(fields.target)) throw new Error('The shortcut target must be absolute.');
  const header = Buffer.alloc(0x4c);
  header.writeUInt32LE(0x4c, 0);
  LINK_CLSID.copy(header, 4);
  header.writeUInt32LE(FLAGS, 0x14);
  header.writeUInt32LE(0x20, 0x18);
  header.writeUInt32LE(fields.showCommand, 0x3c);

  const volumeLabel = ansi('ShellPuppet');
  const volume = Buffer.alloc(0x10);
  volume.writeUInt32LE(volume.length + volumeLabel.length, 0);
  volume.writeUInt32LE(3, 4);
  volume.writeUInt32LE(0x10, 12);
  const volumeData = Buffer.concat([volume, volumeLabel]);
  const base = ansi(fields.target);
  const suffix = ansi(path.win32.basename(fields.target));
  const baseWide = wide(fields.target);
  const suffixWide = wide(path.win32.basename(fields.target));
  const info = Buffer.alloc(0x24);
  info.writeUInt32LE(info.length + volumeData.length + base.length + suffix.length + baseWide.length + suffixWide.length, 0);
  info.writeUInt32LE(0x24, 4);
  info.writeUInt32LE(1, 8);
  info.writeUInt32LE(0x24, 12);
  info.writeUInt32LE(0x24 + volumeData.length, 16);
  info.writeUInt32LE(0x24 + volumeData.length + base.length, 24);
  info.writeUInt32LE(0x24 + volumeData.length + base.length + suffix.length, 28);
  info.writeUInt32LE(0x24 + volumeData.length + base.length + suffix.length + baseWide.length, 32);
  return Buffer.concat([header, info, volumeData, base, suffix, baseWide, suffixWide,
    stringData(fields.description), stringData(fields.workingDirectory),
    stringData(fields.arguments), stringData(fields.icon), Buffer.alloc(4)]);
}

/** Read the fields back for format regression tests. */
export function parseShellLink(bytes: Buffer): ShortcutFields {
  if (bytes.readUInt32LE(0) !== 0x4c || !bytes.subarray(4, 20).equals(LINK_CLSID)) throw new Error('Not a Shell Link.');
  const linkInfo = 0x4c;
  const baseOffset = bytes.readUInt32LE(linkInfo + 28);
  const start = linkInfo + baseOffset;
  let end = start;
  while (end + 1 < bytes.length && bytes.readUInt16LE(end) !== 0) end += 2;
  const target = bytes.subarray(start, end).toString('utf16le');
  let cursor = linkInfo + bytes.readUInt32LE(linkInfo);
  const read = (): string => {
    const length = bytes.readUInt16LE(cursor);
    cursor += 2;
    const value = bytes.subarray(cursor, cursor + length * 2).toString('utf16le');
    cursor += length * 2;
    return value;
  };
  return { target, description: read(), workingDirectory: read(), arguments: read(), icon: read(), showCommand: bytes.readUInt32LE(0x3c) };
}

function desktopQuote(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('$', '\\$').replaceAll('`', '\\`')}"`;
}

export function desktopEntry(fields: ShortcutFields): string {
  return `[Desktop Entry]\nType=Application\nName=ShellPuppet\nComment=${fields.description}\nExec=${fields.target.includes(' ') ? desktopQuote(fields.target) : fields.target} ${fields.arguments}\nPath=${fields.workingDirectory}\nIcon=${fields.icon}\nTerminal=false\nCategories=Utility;\n`;
}

export function installDesktopShortcut(options: ShortcutOptions): string {
  if (options.platform === 'darwin') return 'A shortcut is not available yet on macOS.';
  if (options.fields === undefined) throw new Error('Shortcut fields are required.');
  fs.mkdirSync(options.applicationsDir, { recursive: true });
  const name = options.platform === 'win32' ? 'ShellPuppet.lnk' : 'shellpuppet.desktop';
  const destination = path.join(options.applicationsDir, name);
  const temporary = path.join(options.applicationsDir, `.${name}.${String(process.pid)}.tmp`);
  try {
    fs.writeFileSync(temporary, options.platform === 'win32' ? shellLink(options.fields) : desktopEntry(options.fields));
    fs.renameSync(temporary, destination);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  return `ShellPuppet shortcut installed: ${destination}`;
}

export function uninstallDesktopShortcut(options: Omit<ShortcutOptions, 'fields'>): string {
  if (options.platform === 'darwin') return 'A shortcut is not available yet on macOS.';
  const name = options.platform === 'win32' ? 'ShellPuppet.lnk' : 'shellpuppet.desktop';
  fs.rmSync(path.join(options.applicationsDir, name), { force: true });
  return 'ShellPuppet shortcut removed.';
}

export function userShortcutOptions(platform: NodeJS.Platform = process.platform): ShortcutOptions {
  const entry = fileURLToPath(new URL('./index.js', import.meta.url));
  const viewer = fileURLToPath(new URL('../viewer/', import.meta.url));
  const applicationsDir = platform === 'win32'
    ? path.join(process.env['APPDATA'] ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs')
    : path.join(process.env['XDG_DATA_HOME'] ?? path.join(os.homedir(), '.local', 'share'), 'applications');
  return { platform, applicationsDir, fields: {
    target: process.execPath, arguments: `${platform === 'win32' ? `"${entry}"` : desktopQuote(entry)} desktop`,
    workingDirectory: os.homedir(),
    icon: path.join(viewer, platform === 'win32' ? 'icon.ico' : 'icon-512.png'),
    description: 'Start ShellPuppet', showCommand: 7,
  } };
}
