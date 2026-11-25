import { MAX_BODY_BYTES } from '../core/types.js';
import { EncodedJson } from './http.js';
import type { DaemonConnection } from './http.js';

const submitMarker = ',"submit":true';

/** A request for reporting must fit alongside the original encoded input. */
export function inputRequest(text: string, submit: boolean, verify: boolean) {
  const body = { data: submit ? text + '\r' : text, ...(verify ? { verify: true } : {}) };
  if (!submit) return body;
  const json = JSON.stringify(body);
  if (Buffer.byteLength(json) + submitMarker.length > MAX_BODY_BYTES) return new EncodedJson(json);
  return new EncodedJson(json.slice(0, -1) + submitMarker + '}');
}

/** Keep the mode out of the JSON body, including at the size boundary. */
export function preparedInput(connection: DaemonConnection, text: string,
  submit: boolean | undefined, verify: boolean) {
  if (connection.inputSubmitMode !== 1) {
    if (submit === undefined) throw new Error('This daemon does not support automatic submit. Use explicit submit or upgrade the daemon.');
    return { body: inputRequest(text, submit, verify), options: {} };
  }
  if (!connection.instanceId) throw new Error('The daemon did not provide an instance identity for marked input.');
  const mode = submit === undefined ? 'auto' : submit ? 'on' : 'off';
  return {
    body: new EncodedJson(JSON.stringify({ data: text, ...(verify ? { verify: true } : {}) })),
    options: { submitMode: mode, expectedInstanceId: connection.instanceId },
  } as const;
}
