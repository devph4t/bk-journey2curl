# bk-journey2curl

`bkj2c` reads a **PingOne Advanced Identity Cloud (P1AIC)** journey export and, for each journey, writes:

| Output | File | For |
| --- | --- | --- |
| Bash script | `out/<journey>/<journey>.sh` | Running the whole journey against a tenant |
| Runbook | `out/<journey>/<journey>.runbook.md` | Copying one curl per step, by hand |
| Flow page | `out/<journey>/<journey>.html` | Seeing the journey like the P1AIC canvas, with a curl box on each step |
| Report | `out/index.html`, `out/report.json`, `out/report.md` | Coverage of every journey (people and CI) |

Everything is generated **offline** from the export file. Only the generated curl commands talk to the tenant.

## Install and build

Needs Node.js 20.12 or later.

```bash
npm install
npm run build
```

The generated scripts need **bash 4+, curl and jq 1.6+** (Git Bash on Windows works; install jq separately,
for example `winget install jqlang.jq`).

## Quick start with `.env`

Keep your settings (tenant domain, realm, export file, output folder, port) in `.env` so you don't type them
every time. `.env` is git-ignored; [.env.example](.env.example) is the committed template.

```bash
cp .env.example .env      # then set BKJ2C_TENANT=https://openam-<your-tenant>.forgeblocks.com
npm start                 # build + generate everything + serve it on http://localhost:5174
```

Or step by step:

```bash
npm run build             # build the CLI and the flow page
npm run gen               # bkj2c all, with the values from .env
npm run web               # open http://localhost:5174 (BKJ2C_PORT); Ctrl+C to stop
```

| Variable | Used for | Default |
| --- | --- | --- |
| `BKJ2C_TENANT` | Tenant base URL in the generated curl commands | `https://CHANGE_ME.forgeblocks.com` |
| `BKJ2C_REALM` | Realm | `alpha` |
| `BKJ2C_EXPORT` | Export file when none is given on the command line | (required if no file is given) |
| `BKJ2C_OUT` | Output folder (also what `npm run web` serves) | `out` |
| `BKJ2C_WITH_SESSION` | Journey to run first for journeys that need a session | (none) |
| `BKJ2C_MIN_COVERAGE` | Make `report`/`all` exit 2 below `full`, `partial` or `manual` | (off) |
| `BKJ2C_PORT` | Port for `npm run web` | `5174` |
| `BKJ2C_ENV_FILE` | Read another file instead of `.env` (set it in the shell) | `.env` |

Command-line flags win over `.env`, and values already set in your shell win over the file.
`.env` can also hold `IN_USERNAME`, `IN_PASSWORD` ... for running the scripts: load them with
`set -a; source .env; set +a`. bkj2c never copies `IN_*` values into generated files.

## Use

```bash
# Everything: scripts, runbooks, flow pages and the report (the export file can come from BKJ2C_EXPORT)
node dist/cli.js all export.json -o out --tenant https://openam-xyz.forgeblocks.com --realm alpha --with-session Login

# Only look at the planned path of a journey
node dist/cli.js plan export.json -j DemoSignup

# List every path, then plan a different branch
node dist/cli.js paths export.json -j DemoSignup
node dist/cli.js plan export.json -j DemoSignup --choose "Choose Channel=partner"

# CI: fail (exit 2) when a journey is below a coverage level
node dist/cli.js report export.json -o out --min-coverage partial
```

| Command | What it does |
| --- | --- |
| `plan` | Prints the path, the steps and the inputs of each journey |
| `paths` | Lists every simple path from the start to Success (or Failure) |
| `gen` | Writes `.sh`, `.runbook.md` and `.html` per journey |
| `report` | Writes `index.html`, `report.json`, `report.md` |
| `all` | `gen` + `report` |
| `inspect` | Summarises the export's structure: journeys found / loaded / skipped, sub-journeys, library scripts, unknown node types. `--redact` hides names |

Common options: `-j <journey>` (repeatable), `--choose "<node>=<outcome>"` (repeatable, `Journey/Node=outcome`
for inner journeys), `--target failure`, `-c bk.config.json`, `--exclude-inner` (skip sub-journeys),
`-q` (no loader warnings), `--debug`.

### Large exports, sub-journeys and library scripts

- Every journey in the export is processed, including sub-journeys marked "inner tree only". The report shows
  them as "sub-journey of X"; `--exclude-inner` hides them.
- Each run starts with a line such as `export.json: 40 of 41 journeys loaded (12 inner-tree-only), 85 scripts
  (9 libraries)`, followed by anything skipped and why. The report has a "Not loaded" list too.
- A journey with odd fields (missing positions, a broken connection) is kept and a warning says what was
  ignored. A journey is only skipped when the export entry has no tree at all.
- Scripted nodes that build their callbacks in **library scripts** (`require('MyLib')`) are followed into the
  library: `lib.fn(callbacksBuilder, 'Prompt')`, `const { fn } = require('MyLib')`, helper functions and
  builder aliases are all understood. Libraries missing from the export, callbacks built in loops or under
  conditions are reported as warnings; the generated script's type check catches anything the scan got wrong.
- The flow page has a tab for every sub-journey the journey can run, also those off the planned path (dashed).

If a journey is still missing or looks wrong, run `bkj2c inspect --redact` and share its output: it contains only
counts, node types and placeholder names (J1, L1 ...), never script code, prompts or configuration values.

Supported exports: Platform Admin UI (format 1.1), Frodo (single or multi), a single tree bundle, and raw AM
trees (no canvas positions: the flow page lays nodes out in columns).

## Running a journey

**Whole journey:** set the inputs as environment variables and run the script.

```bash
IN_USERNAME=demo.user IN_PASSWORD='...' ./out/Login/Login.sh
VERBOSE=1 ./out/Login/Login.sh                         # print every request and response
SUSPENDED_ID=<id from the email> ./out/Registration/Registration.sh   # resume after an email step
```

**One step at a time:** open the runbook or the flow page and copy the blocks, in order, into one bash
terminal: *Setup*, *Start*, then each step. Each block posts the last response (`$RESP`) back with its inputs
filled in, so values the server sends (such as the `_id` of Page Node callbacks) are kept.

Exit codes of the script: `0` success, `1` journey failed, `2` unexpected callbacks, `3` stopped at an email
step, `4` missing tool or network error, `5` a step needs a person, `6` one-time code missing.

## Coverage

| Coverage | Meaning |
| --- | --- |
| Full | The script runs the journey on its own (random challenges are answered at run time) |
| Partial | It runs, but stops or needs something extra: an email link, an existing session, a one-time code |
| Manual | A step needs a person (WebAuthn, QR registration) |

## Configuration (`bk.config.json`)

Optional; see [bk.config.example.json](bk.config.example.json).

| Key | Purpose |
| --- | --- |
| `tenant`, `realm` | Defaults for `--tenant` and `--realm` |
| `inputs` | Default values for `IN_*` variables (secrets such as passwords are never written to files) |
| `attributeTypes` | `string` / `boolean` / `number` per attribute collected by Attribute Collector nodes |
| `kbaCount` | Number of security questions at registration (default 1) |
| `choose` | Branch pins, same as `--choose` |
| `solvers` | Custom jq expressions that compute an input from the response, per journey and node |

## Development

```bash
npm test            # unit, snapshot and bash -n tests
npm run lint        # Biome
npm run typecheck   # CLI/library and viewer
npm run dev:viewer  # viewer UI dev server
```

The design is in [bk-journey2curl-design.md](bk-journey2curl-design.md).

## License

[MIT](LICENSE)
