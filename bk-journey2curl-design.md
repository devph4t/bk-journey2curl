# bk-journey2curl – Design

Nov 8, 2026 · @Thanaphat

## Overview

bk-journey2curl is a TypeScript CLI that reads a PingOne Advanced Identity Cloud (P1AIC) journey export and produces three outputs per journey: a step-by-step curl script, an interactive flow page, and a coverage report. Generation works offline from the export file; only running the generated script talks to the tenant.

| Output | Files | Audience |
| --- | --- | --- |
| Curl steps | `out/<journey>/<journey>.sh`, `out/<journey>/<journey>.runbook.md` | Engineers, testers |
| Flow viewer | `out/<journey>/<journey>.html` | Everyone, including non-technical users |
| Report | `out/index.html`, `out/report.json`, `out/report.md` | Leads, reviewers, CI |

**In scope (v1):** Platform Admin UI exports (format 1.1) and Frodo exports; Page Nodes; inner journeys; next-gen and legacy scripted callbacks; branches the server decides at runtime (random or data-driven), handled with variant steps and solvers.

**Out of scope (v1):** editing or importing journeys; completing WebAuthn, social login or email links automatically. These are marked as manual steps.

## 1. High Level Design

The tool is a one-way pipeline: a core library turns the export into one `Plan` per journey, and four independent generators render that plan.

```text
   ┌───────────────────────┐            ┌───────────────────────────┐
   │ Journey export (JSON) │            │ bk.config.json (optional) │
   └───────────┬───────────┘            └─────────────┬─────────────┘
               ▼                                      ▼
   ┌─────────────────────────────────────────────────────────────────────┐
   │ CLI · bkj2c            plan · paths · gen · report · all            │
   └──────────────────────────────────┬──────────────────────────────────┘
                                      ▼
   ┌─ Core library ─ src/load · src/model · src/analyze ─────────────────┐
   │ ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ╔═══════════╗ │
   │ │ Loader       │─►│ Typed model  │─►│ Analyzer     │─►║ Plan      ║ │
   │ │ detect format│  │ journeys,    │  │ node catalog │  ║ steps,    ║ │
   │ │ decode       │  │ nodes, x/y,  │  │ script       │  ║ variants, ║ │
   │ │ scripts      │  │ outcomes,    │  │ scanner,     │  ║ plain text║ │
   │ │ validate(zod)│  │ inner trees  │  │ planner,     │  ║ coverage, ║ │
   │ └──────────────┘  └──────────────┘  │ solvers      │  ║ warnings  ║ │
   │                                     └──────────────┘  ╚═════╤═════╝ │
   └─────────────────────────────────────────────────────────────┼───────┘
                                  the same Plan feeds every generator
   ┌─ Generators ─ src/generate ─────────────────────────────────┼───────┐
   │        ┌──────────────────┬──────────────────┬──────────────┤       │
   │        ▼                  ▼                  ▼              ▼       │
   │ ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌───────────┐ │
   │ │ Curl script  │  │ Runbook      │  │ Flow viewer  │  │ Report    │ │
   │ │ .sh · bash,  │  │ .md · literal│  │ .html ·      │  │ index ·   │ │
   │ │ curl, jq     │  │ curl         │  │ single file  │  │ json · md │ │
   │ └──────▲───────┘  └──────┬───────┘  └──────┬───────┘  └─────┬─────┘ │
   └────────┼─────────────────┼─────────────────┼────────────────┼───────┘
            ▼ runs against    ▼                 ▼                ▼
   ┌ ─ ─ ─ ─ ─ ─ ─ ┐  ┌ ─ ─ ─ ─ ─ ─ ─ ┐  ┌ ─ ─ ─ ─ ─ ─ ─ ┐  ┌ ─ ─ ─ ─ ─ ┐
     P1AIC              Engineers,         Everyone           Leads
     /authenticate      testers                               and CI
   └ ─ ─ ─ ─ ─ ─ ─ ┘  └ ─ ─ ─ ─ ─ ─ ─ ┘  └ ─ ─ ─ ─ ─ ─ ─ ┘  └ ─ ─ ─ ─ ─ ┘
```

- **Input:** the journey export, plus an optional `bk.config.json` for tenant URL, realm, input values, attribute types and custom solvers.
- **CLI (`bkj2c`):** thin layer over the core. `plan` prints the path, `paths` lists alternatives, `gen` writes curl files, `report` writes the report, `all` does everything.
- **Core library:** the loader reads any supported export format; the typed model holds journeys as graphs; the analyzer attaches callbacks, picks the path and scores coverage.
- **Plan:** the single contract between core and output. Adding a new output means writing one generator, with no change to the core.
- **Generators:** curl script and runbook for engineers, the flow viewer for everyone, the report for leads and CI. Only the curl script ever talks to the tenant.

## 2. Low Level Design

The core is a pure library: load the export into a typed model, plan a path through each journey, then hand the plan to generators. Every generator reads the same `Plan`, so the script, the viewer and the report can never disagree.

### 2.1 Data model (`src/model/types.ts`, shared with the viewer)

```ts
type NodeId = string;

interface ExportBundle { meta: ExportMeta; journeys: Map<string, Journey>; scripts: Map<string, Script>; }
interface Journey { id: string; entry: NodeId; description?: string; nodes: Map<NodeId, JNode>; }
interface JNode {
  id: NodeId; type: string; name: string; x: number; y: number;   // x/y = canvas position from the export
  outcomes: Record<string, NodeId>;                               // outcome id -> next node
  config: Record<string, unknown>;                                // node config (script id, attributes, ...)
  inner?: JNode[];                                                // Page Node children, in page order
}
interface CallbackSpec { type: string; prompt?: string; inputs: InputSpec[]; origin: 'catalog' | 'script'; }
interface InputSpec { name: string; kind: 'string' | 'number' | 'boolean' | 'fixed'; variable?: string; value?: unknown; }
// name = IDToken1, IDToken1validateOnly, IDToken2question ...

type StepKind = 'submit' | 'poll' | 'variant' | 'optional' | 'suspend' | 'redirect' | 'manual';
interface Step {
  index: number; journey: string; nodeId: NodeId; nodeName: string; kind: StepKind;
  callbacks: CallbackSpec[]; outcome: string; plainText: string;  // plainText = wording for normal users
  variants?: Variant[];                                           // branches the server picks at runtime
}
interface Variant { label: string; signature: string; callbacks: CallbackSpec[]; solver?: string; }
interface Plan { journey: string; target: 'success' | 'failure'; steps: Step[]; trail: TrailEntry[];
  coverage: 'full' | 'partial' | 'manual'; warnings: Warning[]; }
```

### 2.2 Loader and script decoder

- **Format detection:** `trees` map of bundles (Admin UI 1.1, Frodo multi), a single bundle (`tree` + `nodes`), or a raw tree (`entryNodeId` at top level). `innerNodes` and Frodo's `innernodes` are both accepted.
- **Script decoding:** the export stores each script as a JSON string inside a string (`"\"var langs = ...\""`), so the decoder runs `JSON.parse` until it gets plain source. It also joins Frodo's line arrays and decodes base64 from raw AM REST exports.
- **Validation:** zod schemas check the shape and turn surprises into warnings, not crashes.

### 2.3 Node catalog (node type → callbacks)

One small handler per node type returns the callbacks it sends. Unknown types produce no callbacks plus a warning in the report.

| Node type | Callbacks sent | Notes |
| --- | --- | --- |
| ValidatedUsernameNode | NameCallback; ValidatedCreateUsernameCallback when `validateInput` is true | Login vs Registration |
| ValidatedPasswordNode | PasswordCallback; ValidatedCreatePasswordCallback when `validateInput` is true | Second input `validateOnly` stays false |
| AttributeCollectorNode | One StringAttributeInputCallback per attribute; BooleanAttributeInputCallback for boolean attributes | Types from a config map; `preferences/*` default to boolean |
| KbaCreateNode | KbaCreateCallback per required question | Inputs `question` + `answer`; count from config |
| AcceptTermsAndConditionsNode | TermsAndConditionsCallback | Value `true` |
| ScriptedDecisionNode | Parsed from the script | See 2.4 |
| PageNode | Callbacks of all inner nodes, in page order | One step |
| InnerTreeEvaluatorNode | None itself; the inner journey's steps are spliced in | Recursion guard of 5 levels |
| EmailSuspendNode | SuspendedTextOutputCallback | Step kind `suspend`: script stops, prints the resume command |
| OathTokenVerifierNode, RecoveryCodeCollectorDecisionNode | Code entry callback | Needs a TOTP secret or a recovery code |
| OathRegistrationNode, RecoveryCodeDisplayNode | Text output (QR, codes) + hidden value + confirmation | Step kind `manual` unless a secret is supplied |
| WebAuthnAuthenticationNode | Script text output + HiddenValueCallback `webAuthnOutcome` | Step kind `manual` |
| ZeroPageLoginNode | None | Credentials go in `X-OpenAM-Username` / `X-OpenAM-Password` headers |
| Decision and data nodes (Identity Store, Data Store, Create/Patch Object, Retry Limit, Login Count, ...) | None | Skipped in steps, shown in the viewer |

> Callback shapes for MFA nodes (OATH, recovery codes, WebAuthn) should be verified against the real tenant before v1.

### 2.4 Script scanner

- Matches next-gen calls (`callbacksBuilder.nameCallback('City')`) and legacy calls (`new NameCallback(...)`), keeping order and the first string argument as the prompt.
- Resolves literal arrays (`var choices = ['web','mobile','partner']`) so a ChoiceCallback knows its options.
- Links outcomes to inputs when the script does `action.goTo(choices[picked])` or `c === 0 ? 'accept' : 'decline'`. The planner can then set the index that leads down the chosen path (web = 0, accept = 0).
- Flags a node as **server-decided** when it calls `action.goTo` without reading any callback (for example `Math.random` in Random Challenge Picker).

### 2.5 Path planner

1. Build the outcome graph; Success (`70e691a5-1e33-4ac3-a356-e7b6d60d92e0`) and Failure (`e301438c-0bd0-429c-ab0c-66126501069a`) are the fixed static node ids.
2. Breadth-first search from `entryNodeId` to the target, trying preferred outcomes first (`true`, `TRUE`, `success`, `CREATED`, `PATCHED`, `accept`, `valid`, `pass`, `outcome`, `next`) and retry or failure outcomes last.
3. `--choose "<node name or id>=<outcome>"` pins a branch; `paths` lists every simple path for picking one.
4. Inner journeys are planned recursively: outcome `true` targets the inner Success, `false` the inner Failure.
5. Where a server-decided or data-driven node has other branches with their own interactive steps, those become a `variant` step (one of several shapes) or an `optional` step (may or may not appear, such as ProgressiveProfile on the 3rd login).

### 2.6 Solvers (runtime answers)

A solver turns a received callback into a value, written as a jq expression so the bash script stays dependency-light. Each variant is recognised by its callback-type signature, not by a guess.

| Solver | Matches | Computes |
| --- | --- | --- |
| `env` (default) | Any input | Value of an `IN_*` environment variable |
| `math-sum` | Prompt `what is A + B?` | A + B |
| `echo-text` | TextOutput before a NameCallback | Last word of the message |
| `echo-hidden` | HiddenValueCallback before a PasswordCallback | The hidden value |
| `totp` (optional) | OATH code entry with `IN_TOTP_SECRET` set | Current 6-digit code |

Custom solvers live in `bk.config.json`, keyed by journey and node name.

### 2.7 Generators

- **sh:** bash with curl and jq. A cookie jar keeps the session and load-balancer affinity; `post`, `check` (expected types vs received) and `finish` helpers; polling loops; `case` blocks for variants; a clean stop with the resume command at a suspend step. `--with-session Login` runs Login first for journeys that need a session (UpdatePassword).
- **runbook.md:** each step as a literal curl with the expected request body (`IDToken1`, `IDToken2` ...) and the expected next callbacks.
- **viewer html:** one self-contained file. It embeds the plan as JSON plus a prebuilt Preact app. Boxes sit at the export's x/y, so the layout matches the P1AIC canvas.
- **report:** `index.html` linking every journey, `report.json` for CI, and `report.md` for pull requests.

## 3. Structure

One repo, two build targets: the CLI (Node) and the viewer app (browser), sharing `src/model/types.ts`.

```text
bk-journey2curl/
├── package.json            # bin: bkj2c
├── tsconfig.json
├── bk.config.example.json  # tenant, realm, input values, attribute types, solvers
├── src/
│   ├── cli.ts              # commands: plan | paths | gen | report | all
│   ├── load/
│   │   ├── detect.ts       # Admin UI 1.1, Frodo, raw tree
│   │   ├── loader.ts       # export -> ExportBundle
│   │   └── script-decode.ts
│   ├── model/
│   │   ├── types.ts        # shared with viewer
│   │   └── schema.ts       # zod schemas
│   ├── analyze/
│   │   ├── catalog/
│   │   │   ├── index.ts    # node type -> handler registry
│   │   │   ├── platform.ts # username, password, attributes, KBA, terms
│   │   │   ├── flow.ts     # page, inner tree, email suspend, polling
│   │   │   ├── mfa.ts      # OATH, WebAuthn, recovery codes
│   │   │   └── scripted.ts # script scanner
│   │   ├── planner.ts      # BFS, --choose, inner journeys
│   │   ├── variants.ts     # server-decided and optional steps
│   │   ├── solvers.ts
│   │   ├── plain-text.ts   # wording for normal users
│   │   └── coverage.ts     # full / partial / manual + warnings
│   ├── generate/
│   │   ├── sh.ts
│   │   ├── runbook.ts
│   │   ├── viewer.ts       # injects plan JSON into the built viewer
│   │   └── report.ts
│   └── templates/          # eta: script.sh.eta, runbook.md.eta, report.html.eta
├── viewer/                 # Preact app -> one HTML template
│   ├── index.html
│   ├── vite.config.ts
│   └── src/
│       ├── App.tsx
│       ├── Canvas.tsx      # nodes at export x/y, outcome edges
│       ├── Overlay.tsx     # highlighted path + numbered step badges
│       └── StepPanel.tsx   # plain text, curl, expected response
├── test/
│   ├── fixtures/all-journeys-alpha.json   # the sample export
│   ├── catalog.test.ts
│   ├── planner.test.ts
│   ├── generate.snap.test.ts
│   └── mock-am/server.ts  # fake /authenticate for end-to-end runs
└── out/                    # generated, git-ignored
    ├── index.html
    ├── report.json
    ├── report.md
    └── <journey>/
        ├── <journey>.sh
        ├── <journey>.runbook.md
        └── <journey>.html
```

## 4. Framework and tools

Node 20 LTS with TypeScript 5 throughout; the dependency list stays short and each library has one job.

| Area | Choice | Why |
| --- | --- | --- |
| Runtime | Node.js 20 LTS, TypeScript 5 (strict) | One language for CLI and viewer |
| CLI | commander | Subcommands and flags with little code |
| Export validation | zod | The export format varies by tool and version; schemas give clear warnings |
| Templates | eta | Fast, typed templates for `.sh`, `.md` and report HTML |
| Viewer UI | Preact + TypeScript | React-style components at ~4 KB |
| Viewer build | Vite + vite-plugin-singlefile | Bundles the app into one self-contained `.html` |
| Layout fallback | elkjs | Only when an export has no x/y (raw AM trees) |
| CLI build | tsup | Single bundled `dist/cli.js` |
| Tests | vitest + snapshot tests | Fixtures from the sample export; snapshots catch output drift |
| End-to-end | small Node mock of `/authenticate` | Runs generated scripts without a tenant |
| Lint and format | Biome | One fast tool instead of ESLint + Prettier |
| Generated script needs | bash 4+, curl, jq 1.6+ | Present on most Linux/macOS machines and Git Bash |
| Optional | `@rockcarver/frodo-lib`, `otplib` | Export straight from a tenant; TOTP solver |

## 5. Data flow

Data moves one way through five stages, and each stage's output is a typed object you can dump with `--debug` for inspection.

1. **Export file → raw JSON.** `bkj2c all export.json` reads the file and detects its format.
2. **Raw JSON → `ExportBundle`.** The loader normalises trees, nodes, inner nodes and scripts, and decodes each script to plain source.
3. **`ExportBundle` → `Journey` graphs.** Each tree becomes nodes with x/y, outcomes and config. Inner-journey references are resolved by name.
4. **`Journey` → `Plan`.** The planner picks the path (default: shortest to Success, or as pinned with `--choose`). The catalog and script scanner attach callbacks to each step; variants, optional steps, solvers, plain-language text and coverage are added.
5. **`Plan` → files.** Four generators read the same plan: `sh.ts` and `runbook.ts` (curl), `viewer.ts` (HTML), `report.ts` (index, JSON, Markdown).

At run time the generated script talks to the tenant in a simple loop:

```text
bkj2c script                         P1AIC  /am/json/realms/root/realms/alpha/authenticate
   │  POST {}                          ─────►
   │                                   ◄─────  { authId, callbacks[step 1] }
   │  check types == plan step 1
   │  fill input[].value (env / solver)
   │  POST { authId, callbacks }       ─────►
   │                                   ◄─────  { authId, callbacks[step 2] }  ... repeat
   │                                   ◄─────  { tokenId, successUrl }   → ✔ success
   │                                   ◄─────  { code: 401, message }     → ✘ stop with message
```

## 6. Example input and output

All examples use the sample export `all-journeysExport-alpha-realm-...json` (13 journeys). Login takes 1 step with an optional 2nd; DemoSignup takes 6 steps, one of which the server picks at random.

### 6.1 Input

```bash
bkj2c all all-journeysExport-alpha-realm-openam-aic400-021126s1.json \
  --tenant https://openam-aic400-021126s1.forgeblocks.com --realm alpha -o out/
```

The part of the export the Login plan comes from (trimmed):

```json
"Login": {
  "tree": { "entryNodeId": "a12bc72f-...",
    "nodes": { "a12bc72f-...": { "nodeType": "PageNode", "connections": { "outcome": "7f0c2aee-..." }, "x": 210, "y": 103.5 } } },
  "nodes": { "a12bc72f-...": { "nodes": [
      { "_id": "7354982f-...", "nodeType": "ValidatedUsernameNode" },
      { "_id": "0c80c39b-...", "nodeType": "ValidatedPasswordNode" } ] } },
  "innerNodes": { "7354982f-...": { "validateInput": false }, "0c80c39b-...": { "validateInput": false } }
}
```

### 6.2 `plan` output for Login

```text
Journey: Login  →  Success          coverage: FULL
Path
  Page Node [PageNode] --outcome--> Identity Store Decision --TRUE-->
  Increment Login Count --outcome--> Inner Tree Evaluator [ProgressiveProfile]
     ↳ Login Count Decision --false--> Success
  --true--> Success
Steps
  #1 submit    Page Node        NameCallback(IN_USERNAME), PasswordCallback(IN_PASSWORD)
  #2 optional  ProgressiveProfile / Page Node
               BooleanAttributeInputCallback(preferences/updates), BooleanAttributeInputCallback(preferences/marketing)
               appears only on the 3rd login when preferences are missing
```

### 6.3 `Login.sh` (excerpt)

```bash
: "${TENANT:=https://openam-aic400-021126s1.forgeblocks.com}" "${REALM:=alpha}"
: "${IN_USERNAME:=CHANGE_ME}" "${IN_PASSWORD:=CHANGE_ME}"
: "${IN_PREF_UPDATES:=true}" "${IN_PREF_MARKETING:=false}"

# Step 1 – start the journey
RESP=$(post '{}')
check 1 "NameCallback,PasswordCallback"

# Step 2 – submit Page Node (username + password)
RESP=$(echo "$RESP" | jq --arg u "$IN_USERNAME" --arg p "$IN_PASSWORD" '
  .callbacks[0].input[0].value = $u | .callbacks[1].input[0].value = $p')
RESP=$(post "$RESP")

# Step 3 – optional: ProgressiveProfile preferences page
if [[ "$(types)" == "BooleanAttributeInputCallback,BooleanAttributeInputCallback" ]]; then
  RESP=$(echo "$RESP" | jq --argjson a "$IN_PREF_UPDATES" --argjson b "$IN_PREF_MARKETING" '
    .callbacks[0].input[0].value = $a | .callbacks[1].input[0].value = $b')
  RESP=$(post "$RESP")
fi
finish    # ✔ tokenId, or ✘ the error message
```

### 6.4 `plan` output for DemoSignup (default path: channel = web)

```text
Journey: DemoSignup  →  Success     coverage: FULL (1 variant step, solved at runtime)
  #1 submit   Choose Channel        TextOutputCallback, ChoiceCallback(IN_CHANNEL=0 "web")
  #2 submit   Registration Page     ValidatedCreateUsernameCallback(IN_USERNAME),
                                    StringAttributeInputCallback ×3 (givenName, sn, mail),
                                    ValidatedCreatePasswordCallback(IN_PASSWORD)
  #3 variant  DemoVerifySub         Random Challenge Picker decides on the server:
              · math    NameCallback                          solver math-sum
              · phrase  TextOutputCallback, NameCallback      solver echo-text
              · pin     HiddenValueCallback, PasswordCallback solver echo-hidden
  #4 submit   Terms Consent         TextOutputCallback, ConfirmationCallback(IN_CONSENT=0 "Accept")
  #5 submit   DemoPreferencesSub    NameCallback(IN_CITY), ChoiceCallback(IN_LANGUAGE=0 "en")
  #6 submit   Show Summary          TextOutputCallback (acknowledge)
Warnings
  - Choose Channel=partner adds a NameCallback (partner code); use --choose to plan it
  - DemoVerifySub retries up to 3 times on a wrong answer (Retry Limit)
```

The variant step becomes a `case` on the callback types actually received:

```bash
case "$(types)" in
  "NameCallback")                          # math: "what is 7 + 12?"
    RESP=$(echo "$RESP" | jq '.callbacks[0].input[0].value =
      (.callbacks[0].output[0].value | capture("(?<a>[0-9]+) \\+ (?<b>[0-9]+)")
       | ((.a|tonumber) + (.b|tonumber)) | tostring)') ;;
  "TextOutputCallback,NameCallback")       # phrase: copy the word shown
    RESP=$(echo "$RESP" | jq '.callbacks[1].input[0].value =
      (.callbacks[0].output[0].value | split(" ") | last)') ;;
  "HiddenValueCallback,PasswordCallback")  # pin: echo the hidden demoPin
    RESP=$(echo "$RESP" | jq '.callbacks[1].input[0].value =
      (.callbacks[0].output[] | select(.name == "value") | .value)') ;;
  *) unexpected 3 ;;
esac
RESP=$(post "$RESP")
```

### 6.5 Runbook step (Login, step 2)

```bash
curl -X POST "$TENANT/am/json/realms/root/realms/alpha/authenticate?authIndexType=service&authIndexValue=Login" \
  -H "Content-Type: application/json" -H "Accept-API-Version: resource=2.0, protocol=1.0" \
  -b cookies.txt -c cookies.txt \
  -d '{"authId":"<authId from step 1>","callbacks":[
    {"type":"NameCallback","output":[{"name":"prompt","value":"User Name"}],"input":[{"name":"IDToken1","value":"<IN_USERNAME>"}]},
    {"type":"PasswordCallback","output":[{"name":"prompt","value":"Password"}],"input":[{"name":"IDToken2","value":"<IN_PASSWORD>"}]}]}'
```

Expected next: `tokenId` (or the optional preferences page).

### 6.6 `DemoSignup.html` (what the user sees)

- The canvas shows the 19 DemoSignup nodes at the same positions as in P1AIC, with outcome labels on every line.
- The planned path is highlighted, with badges ① to ⑥ on the steps that send callbacks; untaken branches are greyed.
- Tapping ③ opens a panel: "The system gives you one of three quick challenges (math, a word, or a hidden PIN) and checks your answer", then tabs for **curl**, **expected response** and **variants**.
- Inner journeys (DemoVerifySub, DemoPreferencesSub) expand in place.
- A toggle switches between **Simple** (plain text only) and **Engineer** (callbacks, inputs, curl).

The page embeds its data like this:

```json
{ "journey": "DemoSignup",
  "nodes": [{ "id": "44f13bd7-...", "name": "Choose Channel", "type": "ScriptedDecisionNode", "x": 497, "y": 232.5, "step": 1 }],
  "edges": [{ "from": "44f13bd7-...", "to": "047b76d5-...", "outcome": "web", "onPath": true }],
  "steps": [{ "index": 1, "kind": "submit", "plainText": "Choose where you are signing up from", "curl": "..." }] }
```

### 6.7 Report (`out/index.html`, first rows)

| Journey | Steps | Coverage | Main note |
| --- | --- | --- | --- |
| Login | 1 (+1 optional) | Full | ProgressiveProfile on 3rd login |
| DemoSignup | 6 | Full | Random challenge solved at runtime |
| Agent | 0 | Full | Headers only (Zero Page Login) |
| Registration | 1 | Partial | Stops at Email Suspend |
| UpdatePassword | 1–2 | Partial | Needs a session: `--with-session Login` |
| frAuth2 | 2 + OTP | Partial | Needs `IN_TOTP_SECRET` or a recovery code |
| passwordless2 | 2 | Manual | WebAuthn; only the no-device fallback is scriptable |

`report.json` carries the same data per journey (steps, callbacks, coverage, warnings, unreachable nodes, unknown node types) so CI can fail a build when coverage drops.

## Risks and next steps

The main risk is callbacks decided only at run time; the type check in every step turns a wrong guess into a clear warning instead of a silent failure.

| Risk | Mitigation |
| --- | --- |
| Scripts that build callbacks dynamically (loops, computed prompts) | Best-effort scan, marked `origin: script`; runtime type check flags mismatches |
| Attribute types (string vs boolean vs number) are not in the export | Config map with defaults; optional import of the managed object schema |
| Node callback shapes differ across P1AIC releases | Catalog handlers are small and unit-tested; verify against the tenant before v1 |
| Email, WebAuthn and social steps cannot be finished with curl | Explicit `suspend` / `manual` steps with resume instructions |
| Secrets in generated files | Inputs only through `IN_*` env vars; nothing written to disk except the cookie jar (deleted on exit) |

**Milestones**

1. M1 – loader, catalog, planner, `plan` command, `.sh` generator, tested on the sample export.
2. M2 – runbook and report (HTML, JSON, Markdown).
3. M3 – viewer HTML with canvas, overlay and step panel.
4. M4 – mock AM server and end-to-end tests; optional Frodo and TOTP integration.

**Open questions**

- How many KBA questions does the tenant require at registration?
- Should the viewer default to Simple or Engineer view?
