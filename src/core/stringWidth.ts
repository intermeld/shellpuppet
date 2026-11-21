import xterm from '@xterm/headless';

interface WidthService {
  getStringCellWidth(text: string): number;
}

let widthService: WidthService | undefined;

/** Measure plain text in the same cells as the headless renderer. */
export function stringWidth(text: string): number {
  if (widthService === undefined) {
    // xterm 6 keeps its width helper on the terminal core. Plain row readers
    // can run without a live session, so obtain the service once on first use.
    const terminal = new xterm.Terminal({ cols: 2, rows: 1, scrollback: 0 });
    widthService = (terminal as unknown as { _core: { unicodeService: WidthService } })._core.unicodeService;
  }
  return widthService.getStringCellWidth(text);
}
