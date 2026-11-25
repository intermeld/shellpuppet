import { MAX_BODY_BYTES } from '../core/types.js';

/** A request for reporting must fit alongside the original encoded input. */
export function inputRequest(text: string, submit: boolean, verify: boolean) {
  const body = { data: submit ? text + '\r' : text, ...(verify ? { verify: true } : {}) };
  if (!submit) return body;
  const marked = { ...body, submit: true };
  return Buffer.byteLength(JSON.stringify(marked)) <= MAX_BODY_BYTES ? marked : body;
}
