import type { IPty } from 'node-pty';

export class InputPty implements IPty {
  readonly pid = 0;
  constructor(readonly cols = 120) {}
  readonly rows = 34;
  readonly process = 'stand-in';
  handleFlowControl = false;
  readonly writes: string[] = [];
  paint: (data: string) => void = () => {};
  onData(listener: (data: string) => void): { dispose(): void } {
    this.paint = listener;
    return { dispose(): void {} };
  }
  onExit(): { dispose(): void } { return { dispose(): void {} }; }
  resize(): void {}
  clear(): void {}
  write(data: string): void { this.writes.push(data); }
  kill(): void {}
  pause(): void {}
  resume(): void {}
}
