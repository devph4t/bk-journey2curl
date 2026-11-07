# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Working rules (always follow)

The user may add more rules here over time. Every rule in this section applies to every task.

### 1. Plan first → `_agent/plan/`

Before changing code or files for any non-trivial task, write a plan file, then do the work.

- Path: `_agent/plan/NNN-yyyymmdd-hhmmss.md`
  - `NNN` = next 3-digit number after the highest existing plan (`001`, `002`, ...)
  - timestamp = **UTC+7** time when the plan is created
- Template:

  ```markdown
  # Plan NNN: <title>

  Created: YYYY-MM-DD HH:MM:SS UTC+7

  ## Goal

  <what and why>

  ## Steps

  - [ ] step 1
  - [ ] step 2

  ## Decisions

  <choices made and why (optional)>

  ## Status

  In Progress
  ```

- Tick steps (`- [x]`) as they are done, add steps found along the way, and set `## Status` to `Done`, `Blocked: <reason>` or `Abandoned: <reason>` at the end.
- Small follow-ups to an open plan go into that plan rather than a new one.

### 2. Activity log → `_agent/logs/`

Write a detailed log of what you do, with a UTC+7 timestamp on every line.

- Path: `_agent/logs/yyyymmdd/yyyymmdd-hhmmss.log`, one file per working session (timestamp = session start, UTC+7). Keep appending to the same file for the rest of the session; start a new file when a new session or a new day starts.
- Line format (one line per entry, no multi-line entries):

  ```text
  [YYYY-MM-DD HH:MM:SS UTC+7] <message>
  ```

- Log in detail: tasks started, plan created/updated (with file name), files created/edited/deleted, commands run and their results (tests pass/fail counts, build errors), decisions and why, problems and how they were solved, and the outcome at the end.
- Never write secrets (passwords, tokens, tenant credentials, `IN_*` values) into the log.

### Getting UTC+7 time

Always use the real clock, never a guess:

```bash
TZ=UTC date -u -d "+7 hours" "+%Y-%m-%d %H:%M:%S"   # log line timestamp
TZ=UTC date -u -d "+7 hours" "+%Y%m%d-%H%M%S"       # file name part
```

PowerShell (force the Gregorian calendar; a Thai locale would otherwise give Buddhist Era years such as 2569):

```powershell
(Get-Date).ToUniversalTime().AddHours(7).ToString("yyyy-MM-dd HH:mm:ss", [Globalization.CultureInfo]::InvariantCulture)
```

These formats match the shared toolbox at `D:\source_code\hobby\tools\_scripts` (`log-activity`, `new-plan`). Those tools write to `logs/activity/` and `progress/plan/`, so **do not run them here**. Write into `_agent/` directly.

### 3. Git

- Default branch: `main`.
- Claude may commit on its own (user approval given 2026-11-08). Commit at sensible points, such as a finished plan step or a working change, with clear messages.
- `_agent/` (plans and logs) and generated output (`out/`, `dist/`, `viewer/dist/`) are git-ignored (user request 2026-11-08). Keep writing plans and logs there; they stay on disk only.
- Do not push, force-push, rewrite history or change branches without asking.

## Project

**bk-journey2curl** (`bkj2c`) is a TypeScript CLI. It reads a PingOne Advanced Identity Cloud (P1AIC) journey export and writes three outputs for each journey:

| Output | Files |
| --- | --- |
| Curl script + runbook | `out/<journey>/<journey>.sh`, `out/<journey>/<journey>.runbook.md` |
| Flow viewer (single-file HTML) | `out/<journey>/<journey>.html` |
| Report | `out/index.html`, `out/report.json`, `out/report.md` |

Generation is **offline** (from the export file only). Only the generated `.sh` script talks to the tenant (`/am/json/realms/root/realms/<realm>/authenticate`).

The full design is in [bk-journey2curl-design.md](bk-journey2curl-design.md). Read the relevant section before working on a component. If the code and the design disagree, ask the user before changing either.

### Architecture (one-way pipeline)

```text
export JSON (+ bk.config.json)
  → src/load      detect format, decode scripts, validate with zod   → ExportBundle
  → src/model     typed journeys/nodes (x/y, outcomes, inner trees)  → Journey graphs
  → src/analyze   node catalog, script scanner, planner, variants,
                  solvers, plain text, coverage                       → Plan
  → src/generate  sh · runbook · viewer · report (all read the same Plan)
```

- **`Plan` is the only contract** between the core and the generators. A new output means a new generator, with no change to the core.
- The core (`load`, `model`, `analyze`) is a pure library: no file writes, no network.
- `src/model/types.ts` is shared with the viewer (`viewer/`). Keep it free of Node-only imports.
- Unexpected export shapes and unknown node types become **warnings** in the plan and report, never crashes.
- Every generated script step checks the received callback types against the plan (`check`), so a wrong guess fails with a clear message.

### Key domain facts

- Fixed static node ids: Success `70e691a5-1e33-4ac3-a356-e7b6d60d92e0`, Failure `e301438c-0bd0-429c-ab0c-66126501069a`.
- Supported formats: Admin UI 1.1 (`trees` map), Frodo (single or multi; `innernodes`), single bundle (`tree` + `nodes`), raw tree (`entryNodeId` at the top level).
- Scripts in exports are JSON strings inside strings. Decode with repeated `JSON.parse`; also handle Frodo line arrays and base64.
- Planner: cheapest path (Dijkstra) from `entryNodeId`, preferring positive outcomes (`true`, `success`, `CREATED`, `PATCHED`, `accept`, `valid`, `pass`, `outcome`, `next` ...) over retry/failure ones. `--choose "<node>=<outcome>"` pins a branch. Inner journeys are planned recursively, with a 5-level recursion guard.
- Step kinds: `submit | poll | variant | optional | suspend | redirect | manual`.
- Solvers are jq expressions (`env`, `math-sum`, `echo-text`, `echo-hidden`, optional `totp`). Variants are matched by callback-type signature.
- Secrets: inputs only through `IN_*` env vars. Nothing is written to disk except the cookie jar, which is deleted on exit.

### Implementation notes

- Planner = Dijkstra, not plain BFS. Nodes with `branching: 'preferred'` penalise negative outcomes. `branching: 'server'` nodes have no preference. Entering an interactive node costs +3, so data-driven branches avoid extra pages.
- Branch analysis at server-decided nodes: every branch has 1 step → `variant` step; the chosen branch has 0 steps → the other branch's steps become `optional`; otherwise a warning to use `--choose`. Pinning a server node with `--choose` turns this off and adds an info warning.
- Generated bash: one `step_N` function per step. `SUSPENDED_ID` resumes after the first suspend step. `--with-session` adds `step_sN` functions and `run_session`.

### Step-by-step curl and the flow viewer (plan 004)

- `src/generate/curl.ts` builds the copyable blocks used by the runbook and the viewer. Setup exports `TENANT`, `URL` and `IN_*` (env values win). Start sets `$RESP`. Each step does `jq <fill inputs> <<<"$RESP" | curl ... -d @-`, which keeps the page callbacks' `_id` and the server values.
- Headers verified on the real tenant (from the user's Postman collection): `Accept-API-Version: resource=2.1, protocol=1.0` and `X-Requested-With: ForgeRock`.
- Secret inputs (passwords, answers, codes) always default to `CHANGE_ME`, even when set in bk.config.json.
- `viewer/` (Preact + Vite + vite-plugin-singlefile) draws the P1AIC canvas from the export x/y. It shows a curl box with a Copy button under each step node, a side panel with blocks, body and expected next, inner journeys as tabs, Simple/Engineer modes, and `#step-N` deep links. `src/generate/viewer-data.ts` builds the data and `injectViewerData` replaces the whole `bkj2c-data` script tag.
- Check the viewer visually with headless Edge: `msedge --headless=new --screenshot=<png> --window-size=1600,1000 --virtual-time-budget=4000 "file:///.../out/<J>/<J>.html#step-2"`.

### Layout

```text
src/cli.ts                      commands: plan | paths | gen | report | all
src/index.ts                    library exports
src/config.ts                   bk.config.json (zod)
src/load/                       detect.ts, loader.ts, script-decode.ts
src/model/                      types.ts (shared with viewer: plan, curl blocks, viewer data), schema.ts (zod)
src/analyze/catalog/            index.ts (registry, Page Node), platform.ts, flow.ts, mfa.ts, scripted.ts,
                                script-scan.ts (tokenizer), callbacks.ts (input layouts), types.ts
src/analyze/                    planner.ts (path + variant/optional analysis), solvers.ts, inputs.ts (IN_* names),
                                plain-text.ts, coverage.ts
src/format/plan-text.ts         text for the plan command
src/generate/                   sh.ts, curl.ts (copyable blocks), runbook.ts, report.ts, viewer-data.ts, viewer.ts,
                                paths.ts (safe file names), write.ts (file writing)
src/templates/                  script.sh.eta, report.html.eta, index.ts (eta loader)
viewer/                         Preact app: App, Canvas, StepPanel, CodeBlock, layout.ts, styles.css -> one HTML file
test/                           vitest unit + snapshot tests, fixtures/all-journeys-alpha.json
out/                            generated output (git-ignored)
_agent/plan/, _agent/logs/      Claude's plans and activity logs (git-ignored)
```

### Stack

Node 20+ (developed on Node 26), TypeScript 5.9 (strict), commander 13, zod 4, eta 3, Preact 10, Vite 6 + vite-plugin-singlefile, tsup 8, vitest 3 (+ snapshots), Biome 2. The design's elkjs layout fallback is replaced by a small column layout in `viewer-data.ts` (no extra dependency). Generated scripts need bash 4+, curl and jq 1.6+. Optional: `@rockcarver/frodo-lib`, `otplib`.

Keep the dependency list short. Ask before adding a library that is not listed here.

### Commands

Package manager is **npm** (pnpm is not installed). npm 11 blocks install scripts; esbuild works without its postinstall.

```bash
npm install
npm run build          # vite build (viewer -> viewer/dist/index.html) then tsup -> dist/; copies templates + viewer.html to dist/templates
npm run dev:viewer     # vite dev server for the viewer UI (no data unless a generated page is used)
npm run typecheck      # tsc --noEmit for src/test and for viewer/ (its own tsconfig, Preact JSX)
npm test               # vitest run (unit + snapshot + bash -n on every generated script)
npm run test:update    # accept snapshot changes (review the diff first)
npm run lint           # biome check .
npm run format         # biome check --write .

node dist/cli.js plan  test/fixtures/all-journeys-alpha.json [-j Login] [--choose "Node=outcome"] [--target failure] [--debug]
node dist/cli.js paths test/fixtures/all-journeys-alpha.json -j DemoSignup
node dist/cli.js gen    test/fixtures/all-journeys-alpha.json -o out --tenant https://<tenant> --realm alpha --with-session Login   # .sh + .runbook.md
node dist/cli.js report test/fixtures/all-journeys-alpha.json -o out --min-coverage partial   # index.html, report.json, report.md; exit 2 if below
node dist/cli.js all    test/fixtures/all-journeys-alpha.json -o out --with-session Login     # gen + report
```

File writing lives in `src/generate/write.ts` (`writeJourneyFiles`, `writeReport`), so tests call it without the CLI.

Before committing: `npm run lint && npm run typecheck && npm test`.

`jq` is not installed on this machine, so generated scripts and curl blocks can be syntax-checked (`bash -n`) but not run yet. Running them end to end is M4.

### Milestones

1. **M1** (done): loader, catalog, planner, `plan` command, `.sh` generator, tested on the sample export.
2. **M2** (done): runbook and report (HTML, JSON, Markdown).
3. **M3** (done): flow viewer with a curl box per step, copyable step blocks.
4. **M4** (next): mock AM server and end-to-end tests (needs jq); optional Frodo and TOTP.

Open questions: KBA question count is still open (default 1, `kbaCount`). The viewer opens in Engineer view (curl visible); Simple view is a toggle.

## Conventions

- License: MIT (`LICENSE`). User-facing usage docs live in `README.md`; keep it in step with CLI changes.

- TypeScript strict, ES modules, no `any` without a comment explaining why.
- Each node-type handler is small and has a unit test. Use snapshot tests for generator output.
- Test fixtures come from the real sample export (`test/fixtures/`). Do not commit tenant secrets or real user data.
- Generated bash must run on Git Bash (Windows) as well as Linux and macOS.
