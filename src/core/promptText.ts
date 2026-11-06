export function normalise(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
