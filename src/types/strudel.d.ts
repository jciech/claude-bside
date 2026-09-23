// Strudel ships untyped ESM. Shorthand ambient declarations make every import `any`;
// our own wrappers in src/strudel/ provide the typed surface the rest of the app uses.
declare module '@strudel/core';
declare module '@strudel/mini';
declare module '@strudel/tonal';
declare module '@strudel/transpiler';
declare module '@strudel/webaudio';
declare module '@strudel/soundfonts';
declare module '@strudel/soundfonts/gm.mjs';
declare module 'superdough';
