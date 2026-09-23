// The peggy-generated mini-notation parser, imported directly so validation doesn't load Strudel.
declare module '@strudel/mini/krill-parser.js' {
  export interface KrillLocation {
    start: { offset: number; line: number; column: number };
    end: { offset: number; line: number; column: number };
  }
  export interface KrillSyntaxError extends Error {
    location?: KrillLocation;
  }
  export function parse(input: string): unknown;
}
