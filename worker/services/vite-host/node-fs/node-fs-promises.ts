/**
 * `node:fs/promises` facade. Aliased to `node:fs/promises` when bundling the
 * native plugins; re-exports the promise API from the `node:fs` facade so both
 * specifiers share one implementation over the project filesystem.
 */
import { promises } from './node-fs';

export const { readFile, writeFile, readdir, mkdir, stat, access, rm, cp, glob } = promises;

export { promises as default } from './node-fs';
