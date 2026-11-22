# Site Generator — Faster

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/adzinsyariif/site-generator-speed-20261122/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/adzinsyariif/site-generator-speed-20261122/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A faster drop-in for make.fun's own makefun-site 1.0.0, an entry for the
make.fun bounty [“Build a static site faster”](https://make.fun/bounty/site-generator-speed-01-run-20261122).

`solve.js` is a dependency-free ES module whose `run(input)` returns
exactly the output tree makefun-site 1.0.0's `build()` returns for the
same input — every page, index and tag page, the build report and every
static file, byte for byte — while doing the work measurably faster:

- one scanning pass over every string, no regex where a loop will do;
- HTML escaping folded into the scans instead of a replace callback;
- Markdown rendered straight to an output array, no token objects;
- templates compiled once per case into small JS functions, so a page
  render is a function call and a few direct property reads, not a tree
  walk;
- slug and long-date results memoised inside one case (a fresh memo per
  case, so no case ever sees another case's work);
- ASCII fast paths wherever Unicode normalisation would be a no-op.

`main.ts` is the harness driver: it reads every case from
`/input/cases.json`, answers each one alone with `run()`, and writes the
answers, in the cases' order, to `/output/answers.json`.

## Layout

- `solve.js` — the generator (front matter, Markdown, templates, build pipeline).
- `main.ts` — the case-set driver the harness runs.
- `package.json` — `{"type": "module"}`.
- `LICENSE` — MIT.

## Local check

With the kit unpacked, grade on the practice set the way the server does:

```sh
node <kit>/cli/makefun.mjs grade-local --kit <kit> --bot <this repository> --driver process
```
