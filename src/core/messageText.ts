/** Make terminal control characters visible where peer text is displayed. */
export function visibleMessageText(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}
