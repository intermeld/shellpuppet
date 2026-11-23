export function phaseDriver(): {
  start(phases: [render: string | (() => string), duration: number, row: number][], loopStart?: number): void;
  stop(): void;
  read(bytes: Buffer | string): string;
};
