// Driver for the site-generator entry: reads every case from cases.json,
// answers each one alone with run() from ./solve.js, and writes the
// answers, in the cases' order, to answers.json.
//
// The harness starts this file as `node /bot/main.ts`. Inside the grading
// container the directories are /input and /output; outside a container the
// harness points at its own directories through MAKEFUN_INPUT_DIR and
// MAKEFUN_OUTPUT_DIR.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

// V8's incremental marking off, set before solve.js is imported so all of
// its work runs under it.
setFlagsFromString('--no-incremental-marking');
// The entry runs once, cold, per grading container: TurboFan's optimizing
// compiles cost more CPU than one pass over the cases can repay, and the
// concurrent recompilation threads burn the same single-CPU budget. Off.
setFlagsFromString('--no-turbofan');
setFlagsFromString('--no-concurrent-recompilation');

/** solve.js, imported by its URL (a .js module carries no types) and typed by its contract. */
const { run } = (await import(new URL('./solve.js', import.meta.url).href)) as {
  run: (input: unknown) => unknown;
};

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8')) as {
  id: string;
  input: unknown;
}[];
const answers: unknown[] = [];
for (const c of cases) answers.push(run(c.input));
writeFileSync(join(OUTPUT_DIR, 'answers.json'), JSON.stringify(answers));
