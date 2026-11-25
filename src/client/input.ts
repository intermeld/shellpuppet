import { MAX_BODY_BYTES } from '../core/types.js';
import { EncodedJson } from './http.js';

const submitMarker = ',"submit":true';

/** A request for reporting must fit alongside the original encoded input. */
export function inputRequest(text: string, submit: boolean, verify: boolean) {
  const body = { data: submit ? text + '\r' : text, ...(verify ? { verify: true } : {}) };
  if (!submit) return body;
  const json = JSON.stringify(body);
  if (Buffer.byteLength(json) + submitMarker.length > MAX_BODY_BYTES) return new EncodedJson(json);
  return new EncodedJson(json.slice(0, -1) + submitMarker + '}');
}
