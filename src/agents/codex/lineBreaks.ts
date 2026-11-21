// UAX #14 revision 55, restricted to characters we can classify and measure.
// The names are Unicode Line_Break properties. AI resolves to AL here (LB1).
type BreakClass = 'AL' | 'BA' | 'B2' | 'CL' | 'CP' | 'EX' | 'GL' | 'HH' | 'HY' | 'ID' |
  'IN' | 'IS' | 'NU' | 'OP' | 'PO' | 'PR' | 'QU' | 'SP' | 'SY';

const punctuation: Record<string, BreakClass | undefined> = {};
const groups: Partial<Record<BreakClass, string>> = {
  AL: '#&*<=>@^_`~©®·', BA: '|', B2: '\u2014', CL: '}', CP: ')]', EX: '!?',
  GL: '\u00a0\u2011', HH: '\u2010\u2012\u2013', HY: '-', IN: '…', IS: ',.:;',
  OP: '([{¡¿', PO: '%¢°', PR: '$+\\£¥€±', QU: '"\'«»‘’“”', SP: ' ', SY: '/',
};
for (const [name, chars] of Object.entries(groups)) {
  for (const char of chars) punctuation[char] = name as BreakClass;
}

function classify(char: string): BreakClass | undefined {
  if (/[A-Za-z\u00c0-\u00ff]/u.test(char)) return 'AL';
  if (/[0-9]/u.test(char)) return 'NU';
  if (/[\u4e00-\u9fff]/u.test(char)) return 'ID';
  return punctuation[char];
}

// Unconditional pairs kept together by LB23, LB23a, LB24, LB25, LB28, LB29
// and LB30, after the punctuation and space rules have taken precedence.
const joined: Partial<Record<BreakClass, readonly BreakClass[]>> = {
  AL: ['AL', 'NU', 'OP', 'PR', 'PO'], NU: ['AL', 'NU', 'OP', 'PR', 'PO'],
  PR: ['AL', 'NU', 'ID'], PO: ['AL', 'NU'], ID: ['PO'],
  IS: ['AL', 'NU'], CP: ['AL', 'NU'],
};

function canBreak(text: string, classes: BreakClass[], at: number): boolean {
  const left = classes[at - 1]!;
  const right = classes[at]!;
  const next = classes[at + 1];
  // Codex's textwrap splitter handles ASCII hyphens between alphanumerics.
  if (left === 'HY') return /[\p{Alphabetic}\p{N}]/u.test(text.charAt(at - 2)) &&
    /[\p{Alphabetic}\p{N}]/u.test(text[at]!);
  if (right === 'SP' || left === 'GL') return false; // LB7, LB12
  if (right === 'GL' && left !== 'SP' && left !== 'BA' && left !== 'HH') return false; // LB12a
  if (right === 'CL' || right === 'CP' || right === 'EX' || right === 'SY') return false; // LB13

  let beforeSpaces = at - 1;
  while (classes[beforeSpaces] === 'SP') beforeSpaces--;
  const previous = classes[beforeSpaces];
  if (previous === 'OP') return false; // LB14
  const initialQuote = '«‘“';
  const finalQuote = '»’”';
  if (previous === 'QU' && initialQuote.includes(text[beforeSpaces]!) &&
      [undefined, 'SP', 'OP', 'QU', 'GL'].includes(classes[beforeSpaces - 1])) return false; // LB15a
  if (right === 'QU' && finalQuote.includes(text[at]!) &&
      [undefined, 'SP', 'GL', 'CL', 'QU', 'CP', 'EX', 'IS', 'SY'].includes(next)) return false; // LB15b
  if (right === 'IS') return left === 'SP' && next === 'NU'; // LB15c/d
  if (previous === 'B2' && right === 'B2') return false; // LB17
  if (left === 'SP') return true; // LB18

  // Only ID is East Asian in the supported set. Between two ideographs an
  // opening quote can start a row and a closing quote can end one (LB19/a).
  if (right === 'QU') return left === 'ID' && next === 'ID' && initialQuote.includes(text[at]!);
  if (left === 'QU') return classes[at - 2] === 'ID' && right === 'ID' && finalQuote.includes(text[at - 1]!);
  if (left === 'HH' && right === 'AL' && [undefined, 'SP', 'GL'].includes(classes[at - 2])) return false; // LB20a
  if (right === 'BA' || right === 'HH' || right === 'HY' || right === 'IN') return false; // LB21/22

  // LB25: a run of separators belongs to a number only when it follows a
  // digit. A closing bracket can intervene before a currency or percent sign.
  if (right === 'NU' || right === 'PR' || right === 'PO') {
    let i = at - 1;
    if (right !== 'NU' && (left === 'CP' || left === 'CL')) i--;
    while (classes[i] === 'IS' || classes[i] === 'SY') i--;
    if (classes[i] === 'NU') return false;
  }
  if ((left === 'PR' || left === 'PO') && right === 'OP' &&
      (next === 'NU' || (next === 'IS' && classes[at + 2] === 'NU'))) return false;
  return !joined[left]?.includes(right); // LB31
}

/** Codex wrap pieces, including hanging spaces. An unknown class makes the layout unprovable. */
export function draftWords(text: string): string[] | undefined {
  const classes: BreakClass[] = [];
  for (const char of text) {
    const cls = classify(char);
    if (!cls) return undefined;
    classes.push(cls);
  }
  // All supported characters are in the BMP, so class and string indices agree.
  const words: string[] = [];
  let start = 0;
  for (let at = 1; at < classes.length; at++) {
    if (canBreak(text, classes, at)) {
      words.push(text.slice(start, at));
      start = at;
    }
  }
  words.push(text.slice(start));
  return words;
}
