export interface RequestFailureOptions {
  cols?: number;
  suggestion?: boolean;
  duration?: boolean;
  recover?: boolean;
  trailingGlyph?: boolean;
  status?: number;
  retryable?: boolean;
  failure?: string;
  wrappedChrome?: boolean;
  draft?: string;
  laterTurn?: boolean;
  toolOpen?: boolean;
  quoted?: boolean;
  busy?: boolean;
}
export function requestFailed(options?: RequestFailureOptions): string;
