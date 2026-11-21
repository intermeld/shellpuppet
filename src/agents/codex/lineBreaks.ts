// Codex 0.171.0 uses unicode-linebreak 0.1.5: Unicode 15.0.0, UAX #14 revision 49.
// https://www.unicode.org/reports/tr14/tr14-49.html#Algorithm
type BreakClass = 'AL' | 'BA' | 'BB' | 'BK' | 'CL' | 'CM' | 'CP' | 'CR' | 'EX' | 'GL' | 'HY' |
  'IS' | 'LF' | 'NL' | 'NU' | 'OP' | 'PO' | 'PR' | 'QU' | 'SP' | 'SY';

// LineBreak-15.0.0.txt, U+0000 through U+00FF. After LB1 resolves AI to AL,
// every code point outside the groups below is AL within this range.
const latin1 = Array<BreakClass>(256).fill('AL');
latin1.fill('CM', 0x00, 0x20);
latin1.fill('CM', 0x7f, 0xa0);
const groups = {
  BA: '\t|\u00ad', BB: '´', BK: '\v\f', CL: '}', CP: ')]', CR: '\r', EX: '!?', GL: '\u00a0',
  HY: '-', IS: ',.:;', LF: '\n', NL: '\u0085', NU: '0123456789', OP: '([{¡¿', PO: '%¢°',
  PR: '$+\\£¤¥±', QU: '"\'«»', SP: ' ', SY: '/',
} satisfies Partial<Record<BreakClass, string>>;
for (const name of Object.keys(groups) as (keyof typeof groups)[]) {
  for (const ch of groups[name]) latin1[ch.charCodeAt(0)] = name;
}

function hard(cls: BreakClass): boolean {
  return cls === 'BK' || cls === 'CR' || cls === 'LF' || cls === 'NL';
}

// Pairs kept together by LB23 to LB30 amongst Latin-1 classes. All OP and CP
// here have ordinary width for LB30. LB23a, LB26/27 and LB30a/b need classes
// outside this range.
const joined: Partial<Record<BreakClass, readonly BreakClass[]>> = {
  AL: ['AL', 'NU', 'OP', 'PO', 'PR'],
  CL: ['PO', 'PR'],
  CP: ['AL', 'NU', 'PO', 'PR'],
  HY: ['NU'],
  IS: ['AL', 'NU'],
  NU: ['AL', 'NU', 'OP', 'PO', 'PR'],
  PO: ['AL', 'NU', 'OP'],
  PR: ['AL', 'NU', 'OP'],
  SY: ['NU'],
};

function canBreak(left: BreakClass, right: BreakClass, lastNonSpace: BreakClass | undefined): boolean {
  if (hard(left)) return !(left === 'CR' && right === 'LF'); // LB4/5
  if (hard(right) || right === 'SP') return false; // LB6/7
  // LB8/8a/11 concern ZW, ZWJ and WJ, all outside Latin-1.
  if (left === 'GL') return false; // LB12
  if (right === 'GL' && left !== 'SP' && left !== 'BA' && left !== 'HY') return false; // LB12a
  if (right === 'CL' || right === 'CP' || right === 'EX' || right === 'IS' || right === 'SY') return false; // LB13
  if (lastNonSpace === 'OP' || (lastNonSpace === 'QU' && right === 'OP')) return false; // LB14/15
  // LB16/17 need NS or B2.
  if (left === 'SP') return true; // LB18
  if (left === 'QU' || right === 'QU') return false; // LB19
  // LB20, LB21a/b and LB22 need CB, HL or IN.
  if (left === 'BB' || right === 'BA' || right === 'HY') return false; // LB21
  return !joined[left]?.includes(right); // LB31
}

/** UAX #14 end offsets, including mandatory breaks. Undefined means an unknown layout. */
export function lineBreaks(text: string): number[] | undefined {
  const ends: number[] = [];
  let left: BreakClass | undefined;
  let lastNonSpace: BreakClass | undefined;
  for (let i = 0; i < text.length; i++) {
    let right = latin1[text.charCodeAt(i)];
    if (right === undefined) return undefined;
    if (right === 'CM') {
      if (left !== undefined && left !== 'SP' && !hard(left)) continue; // LB9: retain the base
      right = 'AL'; // LB10
    }
    if (left !== undefined && canBreak(left, right, lastNonSpace)) ends.push(i); // LB2
    left = right;
    if (right !== 'SP') lastNonSpace = right;
  }
  if (text.length) ends.push(text.length); // LB3
  return ends;
}

/** Printable ASCII and Latin-1, the single-line repertoire this reader can verify. */
export const draftRepertoire = /^[\x20-\x7e\xa0-\xff]*$/u;

/** Codex's textwrap 0.16.2 word separator and hyphen splitter, with hanging spaces included. */
export function draftWords(text: string): string[] | undefined {
  if (!draftRepertoire.test(text)) return undefined;
  const breaks = lineBreaks(text);
  if (!breaks) return undefined;
  // The separator filters hyphens first, then replaces its last opportunity
  // with end of text. A final hyphen can therefore absorb the preceding break.
  const ends = breaks.filter(end => text[end - 1] !== '-' && text[end - 1] !== '\u00ad');
  ends.pop();
  if (text.length) ends.push(text.length);

  const words: string[] = [];
  let start = 0;
  for (const end of ends) {
    for (const piece of text.slice(start, end).split(/(?<=[\p{Alphabetic}\p{N}]-)(?=[\p{Alphabetic}\p{N}])/u)) {
      words.push(piece);
    }
    start = end;
  }
  return words;
}
