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

Needs Node.js 20 or later.

```bash
npm install
npm run build
```

The generated scripts need **bash 4+, curl and jq 1.6+** (Git Bash on Windows works; install jq separately,
for example `winget install jqlang.jq`).

## Use

```bash
# Everything: scripts, runbooks, flow pages and the report
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

Common options: `-j <journey>` (repeatable), `--choose "<node>=<outcome>"` (repeatable, `Journey/Node=outcome`
for inner journeys), `--target failure`, `-c bk.config.json`, `--debug`.

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
