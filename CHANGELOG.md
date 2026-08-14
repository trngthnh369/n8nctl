# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.7.0] — 2026-08-14 (workflow archive / unarchive)

### Added

- **`workflow archive <id>`** and **`workflow unarchive <id>`** — the reversible
  alternative to `workflow delete` (which is permanent). Maps to the n8n public
  API `POST /workflows/{id}/archive` and `/unarchive` (n8n-io/n8n PR #27513).
  Archiving forces the workflow inactive; `--dry-run` shows a deactivation note
  when the target is active. Unarchive leaves the workflow inactive (run
  `workflow activate` to re-enable). Both honour `--dry-run`; like `activate`
  and `delete`, they print a status line rather than a JSON document, so
  `--json` does not change their output.
- `Workflow.isArchived` added to the CLI type.

### Notes

- **Instance version gate**: these endpoints were added to the n8n public API
  after the `isArchived` field itself — they are **absent on n8n 1.122.5**
  (live-verified: the model has `isArchived` but `POST /archive` returns 404).
  A 404 is disambiguated at the error path (re-GET the workflow): a genuinely
  missing workflow keeps its 404, while an existing workflow surfaces an
  upgrade hint instead of a bare 404. Upgrade n8n to use the commands.

## [1.6.0] — 2026-08-05 (MCP helpers + repo reunification)

Reunites the `trngthnh369/n8nctl` line, whose `mcp` work had been stranded on a
diverged `main` since the 2026-07-03 migration, and moves the canonical
repository back to `trngthnh369/n8nctl`.

### Added

- **`mcp info|config|compare`** — agent-facing helpers for n8n's instance-level
  MCP surface:
  - `mcp info` prints the derived MCP endpoint (`<host>/mcp-server/http`), the
    separate MCP token env, official MCP/CLI positioning, and production
    guardrails without exposing `N8N_API_KEY`.
  - `mcp config --client <claude|cursor|codex|generic>` emits a
    streamable-HTTP MCP client snippet with a bearer-token placeholder.
  - `mcp compare` clarifies the boundary: n8n MCP exposes tools, the official
    n8n CLI mirrors the public API, and n8nctl remains the validation,
    packaging, promotion, rollback, and agent-safe delivery layer.

### Changed

- **Canonical repository moved back to `trngthnh369/n8nctl`.** `repository`,
  `homepage`, `bugs`, and `author` URLs in both packages now point there, which
  is also a hard requirement for npm provenance (`npm publish --provenance`
  rejects a `repository.url` that does not match the publishing repo).
- `package-lock.json` workspace version resynced (it had been stale at `1.0.1`
  since the 1.2.0 release).

## [1.5.0] — 2026-07-10 (governance coverage + test hardening)

Phase 4 tail — the final roadmap items.

### Added

- **User governance** (licensed: user management): `user invite <emails...>
  [--role global:admin|global:member]` (the invite endpoint takes an array and
  reports per-entry success/failure — partial failures exit 1 with the
  `inviteAcceptUrl` printed per invitee), `user delete <id>` (confirm-gated),
  `user role <id> <global:admin|global:member>`.
- **Project governance** (licensed: Projects): `project create|update|delete`
  plus membership: `project add-user <projectId> <userId>
  [--role project:admin|project:editor|project:viewer]` and
  `project remove-user`. All licensed calls map 403/404 to the standard
  license hint. Endpoint contracts added to the matrix in
  `scripts/SESSION_REST_CONTRACT.md` (mock-tested; live-verify on a licensed
  instance before relying on them in prod).

### Changed

- **CI now enforces coverage thresholds** (`npm run test:coverage`, single
  matrix leg) — the thresholds in `vitest.config.ts` existed since 1.0 but were
  never run in CI. Ratcheted to just under current actuals
  (statements 75, branches 70, functions 80, lines 75 vs actual 79/75/88/79)
  so a coverage regression fails the build while normal churn passes.
- **`doctor` internals split into per-check functions** (node/config/keyring/
  env/connectivity/read-permission/license probes) — the 227-line handler is
  now a composition of small testable checks. No behaviour change.

### Tests

- Paid down the handler-test debt: `auth login` (non-interactive, keyring vs
  `--no-keyring`), `auth logout` (secret purge + activeProfile repointing),
  `auth status` (machine-readable path, key masking), `profile add/remove`,
  `workflow watch` (SIGINT stop path + listener cleanup), plus full coverage of
  the new governance verbs. 487 tests.
- **Cross-package type-compat lock**: a compile-time assertion that the CLI's
  `Workflow`/`WorkflowNode` stay assignable to the validator's input types —
  the `validate()` boundary can no longer silently drift into a cast.

## [1.4.0] — 2026-07-04 (one-shot deploy sequencer + docs-as-code)

### Added

- **`workflow deploy <file>`** — the one-shot sequencer:
  normalize → validate → **create-or-update** → activate → optional
  trigger-registration probe → optional run + **verify gate**. Safety built in:
  - **Unique-name matching** — deploy-by-name updates only when exactly one
    workflow matches; zero → create (unless `--update-only`); **two or more →
    exit 3** with candidate IDs (updating the wrong workflow is a data-loss
    path). `--id`, `--create-only`, `--update-only` for explicit control.
  - **Fail-closed validation** at `ci` by default (a new command, no
    backward-compat concern); `--validate-policy` / `--no-validate` override.
  - **Trigger-registration check** (`--verify-triggers`) probes the webhook
    URL after activation and **exits 6** if it 404s despite `active=true` — the
    self-hosted "active in DB but not registered in-process" trap. Opt-in
    because probing fires the webhook once.
  - **`--run` + verify gate** reuses the Cần+Đủ+Tốt gate (`--expect`,
    `--expect-fields`, `--max-duration-ms`); gate failure → exit 6.
  - **Transaction-log rollback** (`--rollback-on-fail`): a failed update
    restores the pre-deploy body + active state; a failed create is deactivated
    (or deleted with `--rollback-delete-created`).
  - NDJSON events `workflow-deploy-started|step|finished|rolledback`, optional
    `--out-dir` artifact.

  This re-opens and supersedes the 1.0 `PIPELINE_DECISION.md` NO-GO: its reopen
  condition ("a genuinely Claude-free consumer") is now met by the live e2e CI
  job, which deploys with no LLM in the loop.

- **`docs/COMMANDS.md` is generated from the Commander tree**
  (`scripts/gen-command-docs.mjs`), and CI fails if it drifts (`--check`). The
  command reference can no longer fall behind the code (the README tables had
  drifted ~half a release before).

- Live e2e smoke (`scripts/e2e/smoke.sh`) now exercises `workflow deploy`
  end-to-end (deploy → run → gate) — the non-LLM consumer that justifies the
  sequencer.

## [1.3.0] — 2026-07-04 (deploy-path validation, live catalog, coverage)

### Added

- **Deploy-path validation.** `workflow create/update/import/promote` now
  validate the workflow before writing. **Warn-only by default** (issues print
  to stderr, deploy still proceeds — additive, a previously-working deploy keeps
  working); pass `--validate-policy <dev|ci|strict>` to make it a hard gate
  (exit 3), or `--no-validate` to skip. Warn-default is deliberate: E050
  (hardcoded-secret) is CRITICAL and blocks in every policy incl. `dev`, and its
  generic pattern false-positives on benign live workflows — so blocking by
  default would break working promotes/updates with no policy escape.
- **`catalog sync | show | reset`.** `catalog sync` generates an offline
  validator catalog from THIS instance's live node types
  (`/types/nodes.json`, incl. community nodes) so `workflow validate` and the
  deploy-path validation param-check against the ~400+ node types the instance
  actually runs, not the 36-node bundled snapshot. Stored per profile with a
  min-node-count sanity gate + atomic write; `N8N_VALIDATOR_CATALOG` overrides
  the path; `catalog reset` reverts to the bundled catalog. Requires
  `auth login --session` (the asset is behind editor auth). The validator itself
  is unchanged — n8nctl passes the synced catalog via its existing
  `options.catalog`.
- **Missing Public-API coverage**: `execution delete`, `tag update`,
  `tag delete`, `credential delete`, `credential transfer`, `workflow transfer`
  (transfers are licensed: Projects — mapped to a clear hint on 403/404).
- **Dynamic shell completion.** `completion <shell>` now walks the live
  Commander tree, so every command/verb/alias is reflected automatically. The
  previous static lists had drifted ~half a release behind the real surface
  (missing `variable/user/project/source-control/audit/node/catalog` and half
  the workflow verbs).

### Performance

- **inquirer fully lazy-loaded.** Phase 1.2.0 lazy-loaded inquirer in
  `auth login`, but four confirm-gated commands (`workflow delete`,
  `workflow rollback`, `profile remove`, `source-control pull`) still imported
  it at module top level — keeping it on the startup path. All confirm prompts
  now route through a shared lazy `confirmPrompt`, so inquirer no longer loads
  for `--version` or any non-interactive command.

## [1.2.0] — 2026-07-03 (performance: agent-loop latency)

Startup and cross-instance-scan performance, targeted at agents that invoke the
CLI in a tight loop. No behaviour or contract changes.

### Performance

- **Lazy-load heavy formatter/prompt deps.** `table`, `handlebars`, `node-jq`
  (which shells out to a `jq` binary) and `inquirer` were imported at module top
  level, so every invocation — even `--version` — paid their load cost. They are
  now dynamically imported only on the code path that needs them (a `--jq`,
  `--template`, table-render, or interactive-prompt). Measured cold start of
  `--version` dropped ~15–22% (median ~1185 → ~1001 ms; mean ~1295 → ~1013 ms on
  the dev box). Bench harness added at `scripts/bench-startup.mjs`.
- **`workflow promote` scans the target instance in a single pass.** Credential
  derivation and the same-name lookup previously did TWO full `/workflows` list
  scans plus a sequential detail GET per workflow. Now one list pass feeds a
  bounded worker pool (concurrency 8) and both steps read from that in-memory
  set — one list + N parallel detail fetches. Slowest command, biggest win on
  large target instances.
- **`workflow watch` exits immediately on Ctrl+C.** An in-flight poll is now
  cancelled via `AbortController` instead of hanging up to the 30 s request
  timeout before the loop notices SIGINT.

### Internal

- `renderTemplate` is now `async` (it dynamically imports Handlebars). Internal
  helper; not part of the CLI contract.

## [1.1.0] — 2026-07-03 (live node catalog)

### Added

- **`n8nctl node list | describe | search`** — inspect the node types available
  on THIS instance from its own editor catalog (`GET /types/nodes.json`),
  including community / langchain packages, at the exact versions the instance
  runs. `describe <type>` accepts a full type, a short name (`httpRequest`), or
  a fuzzy name (`http`), and collapses the per-version catalog entries to the
  latest schema. `list`/`search` project to a lean shape; `--community` filters
  to non-base packages; `--refresh` bypasses the 24h cache.
- Catalog is cached under the config dir (`cache/node-types-<host>.json`, 24h
  TTL) because the payload is large (~14 MB). Fetched via the **session client**
  (cookie auth) — the asset is served behind editor auth, so the Public-API key
  401s on it; run `n8nctl auth login --session` first.

## [1.0.1] — 2026-07-02 (correctness & release integrity hotfix)

Bug-fix release. Reviewed via a 3-reviewer plan-review bus; the retry change is
a deliberate **behaviour change** shipped under a patch because the old
behaviour could duplicate a resource.

### Fixed

- **`execution retry` hit a non-existent endpoint.** It called
  `POST /api/v1/executions/{id}/retry` on the Public API, which has no retry
  endpoint — it 404'd on real instances and only passed against a mock. Retry
  now goes through the internal `/rest/executions/{id}/retry` endpoint via the
  session client (`n8nctl auth login --session` required), with an optional
  `--load-workflow` flag. Contract pinned in `scripts/SESSION_REST_CONTRACT.md`.
- **Commander parse errors now exit 3 (ValidationError), not 1 or 5.** A bad or
  unknown option/command previously exited 1 (colliding with `ApiError`) via
  Commander's own `process.exit`. `exitOverride` is now applied across the whole
  command tree and mapped through the frozen exit-code contract (`--help` /
  `--version` still exit 0). Spawn-level tested.
- **`config.settings.{timeout,color,outputFormat}` were write-only dead config.**
  They had a full get/set UI but nothing read them. Now wired with correct
  precedence: `--timeout` flag > `settings.timeout` > 30000; `NO_COLOR`/
  `FORCE_COLOR` > `settings.color` > TTY; `settings.outputFormat` sets the TTY
  default (an explicit `--json`/`--jq`/`--template` still wins).
- **`auth status` and `config list` now honour `--json`** (and emit JSON when
  piped), per contract §2 "every read command".
- **Table cell values are ANSI/control-char scrubbed** — a remote workflow name
  can no longer smuggle terminal escape sequences into a TTY via `workflow list`.
- **Release CI could not publish 1.0.0.** The version gate required the tag to
  equal *both* the CLI and validator versions, but they version independently
  (CLI 1.0.0 / validator 0.6.0). The gate now checks the CLI version for `vX.Y.Z`
  tags and adds a separate `validator-vX.Y.Z` trigger; publishes skip a version
  already on the registry (npm versions are immutable, so this also makes reruns
  after a partial failure idempotent), and a `workflow_dispatch` dry-run runs
  build + tests + `npm publish --dry-run` without publishing.

### Changed

- **Retry is now method-aware (behaviour change).** Idempotent methods
  (GET/HEAD/PUT/DELETE) still retry all transient HTTP (429/502/503/504) and
  network errors. Non-idempotent writes (POST/PATCH) retry **only** when the
  server provably did not process the request — HTTP 429 and
  connection-never-established network errors (ECONNREFUSED/ENETUNREACH/EAI_AGAIN)
  — so an ambiguous 502/504/ECONNRESET/ETIMEDOUT after a committed write no
  longer risks a duplicate resource. Webhook requests (data-plane) never retry on
  an HTTP status at all, since the target workflow may have already run. A
  transient network failure on a write may now surface as an error instead of
  silently self-healing — this is intended.

### Added

- **`scripts/e2e/smoke.sh` + `e2e-smoke.yml` workflow** — a minimal live
  end-to-end smoke against a real n8n container (owner bootstrap → API key →
  create → run → **execution retry** → cleanup), run on demand / weekly. This is
  the automated net that catches the class of bug the `execution retry` fix
  addresses; unit mocks alone can't.
- **Endpoint contract matrix** in `scripts/SESSION_REST_CONTRACT.md` — every
  `/rest`-dependent command must document its endpoint/auth/body/shape before
  implementation.

### Docs

- README: removed the phantom `workflow execute` command (real verbs are
  `workflow run` / `workflow trigger-webhook`), added exit code 6 to the table,
  replaced the `NODE_TLS_REJECT_UNAUTHORIZED=0` recommendation with the scoped
  `--insecure` flag, fixed "6-layer" → "7-layer", and corrected the clone URL to
  the `turti369` org.

## [1.0.0] — 2026-06-13 (Phase 4: stabilization)

The lifecycle is complete (build → validate → diff → backup → deploy →
activate → execute → verify → debug → rollback → promote → monitor +
governance) and the agent-facing contracts are frozen under semver.

### Fixed

- **Named `--profile` is now self-contained** (found via live cross-instance
  promotion): with `N8N_HOST` exported in the shell, commander bound it to
  `--host`, so `--profile docker-target` sent the docker key to the prod host →
  401. Now an ambient env `N8N_HOST`/`N8N_API_KEY` does not override an
  explicitly-chosen profile's host/key; only an explicit `--host`/`--api-key`
  CLI flag does (`runtime.ts applyProfileHostPrecedence`, regression-tested).

### Added

- **`docs/CONTRACTS.md`** — the frozen 1.0 contracts (exit codes, output
  selection, NDJSON events, 4-field write payload, redaction, profile
  precedence, subcommand flag naming, destructive-op gates).
- **`docs/PIPELINE_DECISION.md`** — documented NO-GO on a `pipeline` umbrella
  command for 1.0 (the `n8n-pipeline` skill remains the judgment-bearing
  orchestrator; the pure `lib/lifecycle/*` layer keeps a future thin sequencer
  cheap if a Claude-free CI consumer appears).

### Notes

- **`workflow promote` live-validated cross-instance** against a throwaway
  Docker n8n 1.122.5 (the Phase-3 1.0 gate): a 39-node production workflow
  promoted dev→prod (create), re-promoted (idempotent update by name), and
  credential auto-unique matching resolved against the target's real
  credentials. The Docker fixture was torn down; no persistent test profile or
  secret remains.
- **Skills migrated** off the retired `_pipeline/test-gate.js`:
  `n8n-test`/`n8n-deploy`/`n8n-fix`/`n8n-pipeline` now call `workflow verify`
  (exit 6 contract); `n8n-rollback` reduced to a confirm-gate + one
  `workflow rollback` call.
- Per-project ad-hoc curl debug scripts under `D:/Projects/work/*/scripts/`
  are intentionally left as-is (project-local scratch, not the shared
  pipeline); the shared gate script WAS migrated.

## [0.9.0] — 2026-06-13 (Phase 3: cross-instance promotion)

Promotes a workflow from one instance to another (dev → prod) with safe
credential remapping — the hardest item in the roadmap, because credential
NAMES are not unique in n8n and a blind match can silently bind a production
workflow to the wrong secret.

### Added

- **`workflow promote <id> --to <profile> [--from <profile>] [--map <file>]
  [--allow-unmapped] [--out-dir <dir>] [--activate]`** — fetch from the source
  profile, remap every credential reference to the TARGET instance, diff
  against any same-name workflow there, then create-or-update (4-field
  whitelist only).
  - **Credential safety (plan dt-r1-06)**: auto-match by (type, name) ONLY when
    exactly ONE target credential matches. **0 matches → blocks** (unless
    `--allow-unmapped`, which keeps the source ref); **≥2 matches → ALWAYS
    blocks** (ambiguous; `--allow-unmapped` does not cover it) — an explicit
    `--map` entry is required. No silent mis-binding.
  - **Map file** (`--map`): JSON array of `{sourceId | type+name, targetId,
    targetName?}` — an explicit entry always wins.
  - A **redacted mapping report** is printed before any write (never prints
    secret values). `--out-dir` writes `promoted-workflow.json`,
    `mapping-report.json`, and `target-diff.json` for harness-style gating.
  - Target credentials are derived from the target instance's workflow nodes
    (n8n's Public API has no GET /credentials list endpoint).
- **`factory.clientForProfile(profile)`** — build a Public-API client for a
  second named profile, enabling cross-instance commands.

### Notes / testing

- 18 unit + handler tests (credential matching matrix, map-file precedence,
  create-vs-update, artifacts, dry-run, 4-field whitelist). Live-exercised the
  full pipeline against production via a same-profile `--to ... --dry-run`
  (clientForProfile + real credential derivation: 10 credential refs resolved
  to real target ids, 0 unresolved, artifacts written, nothing mutated).
- A second n8n instance for true dev→prod live promotion is a **1.0 gate**
  (disposable Docker fixture) — 0.9.0 is mock + same-instance verified.

## [0.8.0] — 2026-06-12 (Phase 2: governance & API coverage)

Reaches the rest of the Public-API surface (variables, audit, users, projects,
source-control), adds a deterministic `workflow scaffold`, grows the validator
node catalog, and teaches `doctor` to probe license-gated features. Every
licensed endpoint degrades to an actionable hint on community edition.

### Added

- **`variable list|set|delete`** — manage instance variables (`/api/v1/variables`).
  `set` is create-or-update by key (falls back to delete+create where the n8n
  version lacks PUT). License-gated → 403/404 becomes a clear hint.
- **`audit [--categories <list>] [--days-abandoned <n>]`** — the n8n security
  audit report (`POST /audit`, report-only; credentials risk, abandoned
  workflows, instance risks). Categories validated client-side.
- **`user list|get`** — read-only user inspection (`/api/v1/users`).
- **`project list`** — read-only project listing (`/api/v1/projects`, license-gated).
- **`source-control pull [--force]`** — pull from the connected git branch with
  MANDATORY guardrails (plan dt-r1-05, widest blast radius in the CLI): a
  pre-pull snapshot bundle of every workflow is written first (rollback point;
  `--skip-backup` to opt out with a warning), confirm gate (`--yes` required in
  non-TTY; `--force` gets a louder prompt), and the import result is printed.
- **`workflow scaffold --from <webhook|cron|manual|file> [--name] [-o]`** —
  generate a normalize-clean, validator-clean skeleton. Output is **byte-stable**
  across runs (deterministic node ids from node names) and passes
  `validate --policy strict` out of the box. Builtins track the catalog's latest
  typeVersions. `--from` (not `--template`) because `--template` is the global
  Handlebars-output flag.
- **`workflow validate --fix`** — apply the mechanical normalize-class fixes
  (node ids → E071, log settings → E070) in place, then validate. Semantic
  fixes remain the n8n-fix skill's job.
- **`doctor`**: license-feature probes (Variables/Projects) reported as
  warn-with-remediation; **machine-readable `--json` output** with a
  `remediation` field per failed check (no `doctor --fix` by design — the
  asymmetric risk of auto-mutating config/keyring outweighs the convenience).
- **Validator catalog 1.1.0 → 1.2.0**: 21 → 36 nodes (added stickyNote, noOp,
  googleDrive, errorTrigger, limit, emailSend, telegram, redis, postgres,
  extractFromFile, convertToFile, html, markdown, langchain agent + chainLlm),
  prioritized by real usage in the production corpus. Conservative `required`
  sets (corpus-verified or empty) — zero new false E061/E062 on real workflows.

### Notes

- Live probe of the production instance (1.122.5): Variables and Projects APIs
  return **403** — surfaced correctly as the license hint. (Confirm the plan
  tier / API-key scope if these features are expected to be available.)

## [0.7.0] — 2026-06-12 (Phase 1: verify & debug loop)

The Cần+Đủ test gate moves INTO the CLI (`workflow verify`, exit 6), the debug
loop gets a per-node `execution logs` view with a default-on redaction
contract, and rollback becomes a first-class guarded command. Live-verified on
n8n 1.122.5 (including a cron-registration probe — see Notes).

### Added

- **`workflow verify <workflowId> [--execution <id>] [--run]`** — the
  CẦN/ĐỦ/TỐT gate, ported 1:1 from the external `_pipeline/test-gate.js` (now
  retired) and extended: versioned expectation files (`--expect gate.yml`,
  `version: v1`) with per-node assertions (`nodes[].ran/minItems`),
  `--expect-fields a,b,c`, `--max-duration-ms` (TỐT warns; `failOnSlow: true`
  escalates), `--run` (execute via /rest session mode, wait, then gate),
  `--capture <file>` artifact (redacted by default). **Gate failure exits 6
  (AssertionFailed)** — distinct from infra errors 1–5; TỐT-only warnings keep
  exit 0 (the old script's exit 2/3 collapse into 6/0; tier detail lives in
  `--json` output). **Fails CLOSED** when execution data is pruned/disabled.
- **`execution logs <id> [--node] [--errors-only] [--io-data]`** — compact
  per-node view (status, duration, items, error). **Redaction contract**:
  execution IO is redacted by default (`lib/redact-execution.ts` — secret-named
  keys + secret-shaped values like JWTs/Bearer/API-key patterns);
  `--unsafe-raw-io` bypasses with a warning. IO previews are size-trimmed.
  Exits 1 if any node errored.
- **`workflow rollback <id> [--to <file>] [--backup-dir <dir>] [--reactivate]`**
  — first-class rollback with the mandatory ordering: safety snapshot → target
  selection (the just-written snapshot is **excluded**; newest
  `*_<id>_*.json` wins, or `--to`) → diff preview → confirm (`--yes` required
  in non-TTY; fails closed) → restore (4-field whitelist) → post-restore
  verify → optional `--reactivate`. `--dry-run` stops after the diff and
  writes nothing.
- **`trigger-webhook --expect-status <code> --capture <file>`** — single-shot
  webhook probe (deliberately NO retry → no double-fire, exact status);
  status mismatch exits 6; capture is redacted by default
  (`--unsafe-raw-io` to bypass).
- **`ExitCode.AssertionFailed = 6`** + `AssertionFailedError` (`errors.ts`),
  documented in `docs/EXIT_CODES.md`.
- **Validator 0.5.0**: severity policy profiles (`dev` = CRITICAL blocks,
  `ci` = +HIGH (default, unchanged), `strict` = +MEDIUM; `strict: true` stays
  as alias) and `fixable: true` annotations on E070/E071 (clearable by
  `workflow normalize`). CLI: `workflow validate --policy <dev|ci|strict>` —
  named `--policy` because a subcommand `--profile` can never win against the
  GLOBAL auth `--profile` flag (commander consumes program-level options
  before dispatch; verified on commander 12.1).

### Fixed

- **`execution wait` and `execution last-error` are now actually registered.**
  Both commands existed as source files (and were documented in skills) since
  the workspace split, but were never added to the `execution` command group —
  the CLI rejected them with "unknown command".

### Notes (live verification on n8n 1.122.5, single-main)

- **Cron triggers DO register via Public-API activate**: a schedule-trigger
  workflow created + activated entirely via API fired on schedule (2/2
  one-minute ticks) with no UI Save. This closes the long-open question from
  the 0.5.0 POC (webhooks were verified then; cron now too).
- `workflow verify` / `verify --run` / `workflow rollback` live-verified
  end-to-end against production on a disposable workflow (created, gated,
  mutated, rolled back, deleted).

## [0.6.0] — 2026-06-12 (Phase 0: hardening + test harness)

Closes every CRITICAL/HIGH/MEDIUM finding from the 2026-06-12 audit (verified
through the plan-review debate bus — converged round 1, 12/12 findings accepted)
and introduces a command-handler test harness so handler logic is no longer
untested. No new user-facing commands — this is a correctness/robustness release.

### Behavioral changes (review before upgrading scripts/skills)

- **`--template` (Handlebars) is now strict.** A reference to an undefined
  property throws a `ValidationError` (exit 3) instead of silently rendering an
  empty string. This matches the long-documented contract; fix any template
  that referenced a field that does not exist. (`output.ts`)
- **Numeric flags reject non-integers.** `--limit`, `--timeout`, `--poll`,
  `--delay`, `--interval`, `--concurrency` now error (exit 3) on values like
  `abc` or `1.5` instead of sending `NaN` to the API. Valid values are
  unaffected. (`--delay 0` is still allowed = no pause.)
- **Exit-code MECHANISM changed, VALUES preserved.** Handlers no longer call
  `process.exit()` (it truncated async stdout flushes on Windows); they set
  `process.exitCode`. The emitted codes are identical — `workflow status --exit`
  still yields `0`/`1`, `refresh` still `1` when inactive. See `docs/EXIT_CODES.md`.
- **`--auth-bearer` + `--auth-basic` together is now an error** instead of
  silently letting basic win. (`workflow trigger-webhook`)

### Fixed

- **scrubAnsi removes whole escape sequences, not just the introducer.** Error
  text from the API no longer leaves printable residue like `[2J` / `]0;title`
  on the terminal. (Note: this is cleanup — the ESC byte was already stripped by
  the C0 range, so no sequence could ever *execute*; it was never a hijack.)
- **`workflow tag` / `doctor` no longer silently drop tags past the first 250.**
  Tag lookups paginate fully via `fetchAllTags()` (cursor-based). `tag list`
  already had `--all` and is unchanged.
- **`workflow tag --create` no longer creates tags under `--dry-run`.**
- **`doctor --verbose` routes through the API client** (honors `--insecure`,
  timeout, auth, and the real User-Agent) instead of a bare `fetch()` with a
  stale hardcoded `n8nctl/0.4.0` UA that broke on self-signed TLS instances.
- **Session `/rest` responses are shape-checked** — a non-object payload throws
  a clear `ApiError` instead of the old silent `(r.data ?? r)` double-cast.
- **`config set` rejects prototype-chain key segments** (`__proto__`,
  `constructor`, `prototype`).
- **`workflow watch` caps remembered execution IDs** (bounded set, 5000) so a
  long-running session no longer grows memory without bound.
- **`workflow diff` no longer lists `staticData`** as a diff field (it is
  server-side read-only; n8n PUT rejects it — showing it misled reconciliation).

### Changed (internals)

- Command handlers extracted to exported functions (`create`, `activate`,
  `refresh`, `run`, `tag`, …) so they are unit-testable with an injected
  Factory — a new in-memory `tests/helpers/fake-factory.ts` captures
  stdout/stderr and the NDJSON event stream.
- `lib/version.ts` is the single source for `USER_AGENT` (derived from
  `package.json`; was hardcoded in three places, one stale).
- `lib/util.ts` centralizes `sleep()` (was copy-pasted in five files),
  `parsePositiveInt()`, and a `BoundedSet`. `lib/tags.ts` adds `fetchAllTags()`.
- CI: `npm audit` is no longer `continue-on-error` (a HIGH production-dep
  vulnerability now fails the build).
- Tests: 164 → 220.

## [0.5.0] — 2026-06-09

Adds **session mode** — authenticate against n8n's internal `/rest` API with a
login cookie to **execute workflows headless**, which the Public API cannot do
(it has no execute endpoint). This is how an autonomous pipeline verifies a
manual / scheduled / sub-workflow, or fires a workflow when the webhook router
is stuck (n8n Issue #21614, queue mode). Ported from a verified reference
(`n8n_session.py` + the autonomous-trigger playbook); contract pinned in
`scripts/SESSION_REST_CONTRACT.md`. Live-verified end-to-end on n8n 1.122.5.

### Added

- **`workflow run <id> [--trigger <name>] [--wait] [--timeout <ms>]`** —
  execute a workflow via `POST /rest/workflows/{id}/run` (the UI "Execute
  Workflow" endpoint, session-cookie auth). Auto-picks a non-webhook trigger
  when a workflow has several (`--trigger` to disambiguate; webhook triggers
  return `waitingForWebhook` and are reported with a fix hint). `--wait` polls
  `GET /rest/executions/{id}` to a terminal state and exits 1 on non-success
  (pipeline gate signal). Respects `--dry-run` / `--json` / NDJSON.

- **`auth login --session [--email <addr>] [--cookie-only]`** — configure
  email/password session auth. Verifies via login + whoami; caches the cookie
  in the OS keyring; stores the password in keyring (or `--cookie-only` to
  store nothing and re-auth on expiry). Merges into an existing profile so an
  API key on the same profile is preserved (`authMethods` tracks both).

- **`N8nSessionClient`** (`src/lib/session-api.ts`) — cookie-auth `/rest`
  client sharing the retry/backoff transport. Single-flight 401 re-login
  (concurrent 401s await one login; `login()` itself is exempt to avoid
  recursion on bad creds). Body schema follows the verified `ManualRunPayload`
  contract — never sends `runData: {}` (which would select the Partial variant
  → HTTP 500).

- `resolveSession()` (separate from `resolveAuth` — the API-key path is
  unchanged, `apiKey` stays required) reading env (`N8N_EMAIL` + `N8N_PASSWORD`
  + `N8N_HOST`) → profile `session` block (password/cookie from keyring).

### Changed

- **Transport extracted** to `src/lib/transport.ts` (`runWithRetry`) so the
  Public-API and session clients share one retry/backoff/NDJSON-event engine.
  `N8nClient` is now a thin wrapper. Pure refactor — all prior tests stay green.

### Workflow quality (normalize + new validator rules)

Fixes three recurring defects in agent-generated workflow JSON:

- **`workflow normalize <file> [-o <out>|-w]`** + **auto-normalize in
  `create`/`update`** (`--no-normalize` to opt out). Behaviour-preserving:
  - **Node ids** → UUID for any non-UUID/missing id. **Deterministic** (derived
    from the node name) so repeated updates don't churn ids or diffs. Safe
    because n8n keys connections / pinData / `$node[...]` on the node NAME.
  - **Settings** → injects execution-log defaults (`saveDataErrorExecution`,
    `saveDataSuccessExecution`, `saveManualExecutions`, `executionOrder`) when
    absent, so failures are actually logged for debugging. Never overwrites an
    explicit value.
  - Does NOT touch `typeVersion` (bumping is risky — params differ across
    versions).
- **Validator (`@trngthnh369/n8n-workflow-validator` 0.4.0) — 3 new rules:**
  - **E072** (MEDIUM) — `typeVersion` is older than the catalog's latest.
  - **E070** (MEDIUM) — workflow `settings` missing execution-log keys.
  - **E071** (LOW) — node id is not UUID format. (Adds `LOW` severity, which
    never blocks — even under `--strict`.)

### Fixed (auth UX)

- **`auth login --session` is now non-interactive when env is set** — reads
  `N8N_EMAIL` / `N8N_PASSWORD` / `N8N_HOST` and only prompts for what's missing
  (was: always prompted for the password, so it couldn't be scripted).
- **`auth login --session` attaches to the ACTIVE profile** (merging with an
  existing API-key profile) instead of a hard-coded `"default"` — so
  `workflow run` resolves the session from the profile you actually use.
- **`auth logout --profile <name>` now honors the global `--profile` flag**
  (previously the subcommand ignored it and fell back to the active profile,
  which could remove the wrong profile).

### Security

- `auth logout` and `profile remove` now **purge ALL keyring material** for the
  profile (API key + session password + cookie) via `purgeProfileSecrets()` —
  previously they deleted only the API-key account, orphaning session secrets.
- Recommend a dedicated automation user (member role) for session creds; the
  stored password is a full login (broader blast radius than a scoped API key)
  so document rotation and prefer `--cookie-only` on shared machines.

## [0.4.0] — 2026-05-08

Closes the long-standing `credential` gap: agents and CI scripts can now
provision n8n credentials without touching the n8n web UI. Also fixes a
silent 400 on `workflow update` when backups contain pinData / staticData.

### Added

- **`credential create <file>`** — POST a credential to n8n from a JSON
  file (or stdin via `-`). The file must contain
  `{name, type, data: {...}}`. Pre-flight validation fetches
  `/credentials/schema/<type>` and asserts every required field is
  present in `data` before the POST. If the schema endpoint is
  unavailable (older n8n, transient failure) a warning is emitted and
  the create proceeds — POST will still surface n8n's own validation
  error.

- **`--no-validate`** flag on `credential create` to skip the schema
  pre-flight when the user knows better (forward-compat with n8n versions
  whose schema endpoint diverges from the actual POST shape).

### Fixed

- **`workflow update` / `create` / `restore` / `import` no longer send
  extra fields that n8n PUT rejects with HTTP 400.** Pre-0.4.0 the
  internal `stripReadOnlyFields` helper was a blacklist of 6 fields
  (id, createdAt, updatedAt, versionId, active, tags), which silently
  let `pinData`, `staticData`, and `meta` slip through. n8n's Public
  API enforces a strict 4-field whitelist (`name`, `nodes`,
  `connections`, `settings`) and 400s on anything else — most visible
  when restoring a backup taken right after a manual test run (pinData
  populated by the web UI). The helper is now whitelist-based and
  forward-safe against future n8n-added fields. Regression tests pin
  pinData/staticData/meta/unknown-field drops.

- **`workflow tag` no longer throws `name.toLowerCase is not a function`.**
  Commander v12 passes a variadic positional (`<tag-names...>`) to the
  action handler as a single nested array, so `args.slice(1)` produced
  `[[name1, name2, ...]]` instead of `[name1, name2, ...]`. The inner
  loop then tried `[...].toLowerCase()`. Introduced `parseTagArgs()` that
  flattens any nesting depth, drops non-string entries, and validates
  that id + at least one tag name were supplied. Also hardened the
  `/tags` response handler against null `data` / non-string `name`
  fields. 9 regression tests in `tests/workflow-tag.test.ts`.

- **`doctor` no longer accumulates a garbage tag on every run.** The
  write-permission probe used to POST a fresh random-named tag
  (`n8nctl-<random>`) each run and DELETE it afterward — but on API keys
  that have CREATE without DELETE scope, every `doctor` invocation left
  one more orphan tag on the instance. The probe now reuses a single
  fixed-name tag (`n8nctl-doctor-probe`): if a probe tag already exists
  the create is skipped (write scope is already proven), so the tag count
  can never grow. Cleanup is best-effort across ALL probe tags found, so
  a key WITH delete scope also sweeps up legacy random-suffix orphans
  from older versions in a single run. Probe detection is strict
  (`n8nctl-doctor-probe` or `n8nctl-` + exactly 12 base36 chars) so
  user-owned tags like `n8nctl-prod` are never touched. Extracted to a
  pure `probeWritePermission()` with 13 tests in `tests/doctor-probe.test.ts`.

### Changed

- **Fixed misleading `✗` icon on success.** `workflow delete` and
  `profile remove` printed a red `✗` (the failure glyph) on a successful
  operation, making a clean delete look like an error. Both now print a green
  `✓`, consistent with create/restore/tag. (Genuine-failure `✗` in
  refresh/import/export-all/last-error/doctor are unchanged — those are real
  errors.)

- **`workflow refresh` no longer over-promises.** Its description and success
  message claimed it "re-registered webhook handlers", but on queue-mode /
  separate-webhook-process n8n the deactivate→activate cycle (and API activate
  in general) only sets `active=true` in the DB without refreshing the running
  process's webhook/cron router — so webhooks 404 and cron never fires. The
  command now reports `cycled → active` plus a note that a UI "Save" (or n8n
  restart) is required if a trigger still doesn't fire. The whitelist `create`
  also added explicit regression coverage for `triggerCount` + `shared` (the
  fields a GET-fetched workflow carries that triggered the reported 400).

### Security

- The `credential-created` NDJSON event emits only `{id, type, name}` —
  never `data`. A regression test asserts no client lifecycle event ever
  serializes the request body, so secrets cannot leak via stderr capture.

- Output of `credential create` is restricted to a safe view
  (`{id, name, type, createdAt, updatedAt}`); even if a future n8n
  version echoes the data field on POST response, it is dropped before
  reaching stdout.

### Not in scope

- `credential delete` and `credential update` deliberately deferred. The
  destruction blast radius (a deleted credential breaks every workflow
  using it) outweighs the convenience gain — the n8n web UI remains the
  authoritative path for those.

## [0.3.0] — 2026-04-28

Tier S agent-observability features driven by an external comparative
audit against `gh`, `stripe`, `aws`, `gws`. Goal: close the three gaps
that genuinely matter when an LLM (Claude Code, agent harness) is the
primary CLI consumer.

### Added

- **`--log-format <text|ndjson>` global flag** (also `N8NCTL_LOG_FORMAT`
  env). NDJSON mode emits one JSON object per stderr event so an agent
  can parse progress without regex. Events: `http-request`,
  `http-response`, `http-retry`, `http-error`, `tls-verification-disabled`.
  Each event has `ts`, `level`, plus per-event payload (label, method,
  url, status, durationMs, attempt). Spinners are auto-disabled in
  NDJSON mode to avoid polluting the event stream.

- **`doctor --verbose`** appends a "Server stats" section: n8n version
  (from `x-n8n-version` header if exposed), GET /workflows latency p50
  with 5 raw samples, total/active workflow counts, last-50 execution
  counts + failure rate, rate-limit headers. Lets agents make informed
  decisions ("backoff because we're at 90% rate limit" vs "proceed").

- **`workflow schema [--node <type>] [--list]`** — first-class schema
  introspection. Without flags: returns the Workflow resource shape
  (required/optional fields, read-only fields, an example workflow).
  `--node http` (or any short alias / full type): returns required,
  optional, enums, and conditionalRequired from the offline catalog.
  `--list`: enumerates all 21 node types in the catalog with version.
  Solves the agent-fabrication-of-field-names problem the CLI was
  originally built to address.

### Changed

- N8nClient now accepts an `onEvent` callback (used internally by the
  factory). HTTP requests/retries/errors fan out structured events
  through this hook, which the IO layer renders as text or NDJSON
  based on the active format. No public API change for command code.
- `process.env.N8NCTL_TRACE=1` continues to work as a separate text-mode
  trace channel; redundant when `--log-format=ndjson` is used.

## [0.2.5] — 2026-04-26

### Added

- **`workflow status <id>`** — first-class command for "is this workflow
  active?" Pretty output by default (active badge, tags, webhook URLs,
  last execution, exit code mapped to active state). `--json` / `--jq` /
  `--template` work as on every other command. `--exit` forces exit code
  semantics even in TTY (useful for `if n8nctl wf status 42; then ...`).
  Replaces the previous workaround of `workflow get <id> --jq '.active'`.
- **`workflow refresh <id>`** — workaround for the n8n bug where webhook
  routes go stale after a workflow is updated via API while active.
  Performs `deactivate → wait <ms> → activate`. Default delay 500ms.
  Bails (exit 1) if workflow is inactive, with a hint to call `activate`
  instead. Honors `--dry-run`.

### Why these were needed

A pipeline that did `workflow update --activate → trigger-webhook` saw
n8n report `active: true` but the webhook URL still 404'd. The webhook
router on the n8n side caches handlers tied to the workflow version at
the moment of activation. Updating in place doesn't invalidate the
cache. Cycling deactivate→activate forces re-registration.

The other failure mode this addresses: external tooling (slash commands,
other Claude sessions) reaching for the raw n8n API to check workflow
state, because the existing `workflow get --jq '.active'` wasn't
discoverable enough. `workflow status <id>` puts state checks on the
expected first-class surface.

## [0.2.4] — 2026-04-26

### Added

- **`workflow create --activate` and `workflow update --activate`** — new
  flag activates the workflow immediately after the create/update succeeds.
  Useful for CI/CD pipelines that need the production webhook to register
  in the same step. Without this flag a workflow ships as `active: false`
  and any `trigger-webhook` against it returns 404 because the webhook URL
  was never bound.

### Changed

- **`workflow trigger-webhook` now pre-checks `workflow.active`.** If a
  user tries to trigger the production endpoint of an inactive workflow,
  the CLI now bails with a `ValidationError` (exit 3) and a hint instead
  of forwarding a confusing 404 from n8n. The hint shows three escape
  hatches:
    n8nctl workflow activate <id>
    n8nctl workflow trigger-webhook <id> --test  (requires UI listener)
    n8nctl workflow update <id> <file> --activate  (atomic deploy+activate)

  Background: n8n only registers the `/webhook/<path>` URL when the
  workflow is active. The new pre-check turns a silent failure mode that
  surfaced in real CI runs into an actionable error.

## [0.2.3] — 2026-04-26

### Fixed

- **`workflow backup --dry-run` now respects the flag.** Previously it
  always wrote the backup file regardless of `--dry-run`. The output
  directory is also no longer created on dry-run.
- **`auth login` no longer prompts when credentials come from env vars
  or program-global flags.** Commander declares `--host` / `--api-key` /
  `--profile` both at the program level (with env fallback) AND on the
  `auth login` subcommand — the values do not merge across scopes. The
  subcommand now falls back to the global flags via `factory.flags` when
  its own option is undefined, so all three of these now skip prompts:
  - `n8nctl auth login --host X --api-key Y`
  - `n8nctl --host X --api-key Y auth login`
  - `N8N_HOST=X N8N_API_KEY=Y n8nctl auth login`

No code changes in `@trngthnh369/n8n-workflow-validator`; published in
lock-step with the CLI.

## [0.2.2] — 2026-04-24

### Added

- **`@trngthnh369/n8n-workflow-validator`**: node catalog bumped from
  v1.0.0 to v1.1.0 with typeVersions observed on a live Pierre Cardin VN
  n8n instance. Eliminates false-positive E060 warnings for workflows
  using current n8n releases:
  - `n8n-nodes-base.googleSheets`: added **4.5, 4.6, 4.7**
  - `n8n-nodes-base.merge`: added **3.2**
  - `n8n-nodes-base.scheduleTrigger`: added **1.3**
  - `@n8n/n8n-nodes-langchain.openAi`: added **1.7, 1.8**

### Changed

- Node catalog `_meta.version` now tracks independently of package version
  + includes a short `changelog` object explaining each catalog bump.

## [0.2.1] — 2026-04-24

Tag exists for historical purposes but was never published to npm —
GitHub Actions was disabled at the account level during this window, so
the tag-triggered release pipeline did not fire. See v0.2.2 for the first
release that actually ships.

### Changed (would-have-been)

- Release pipeline rewritten for monorepo tag-triggered publish with
  provenance. Ready to ship as soon as Actions is re-enabled.

### Changed

- **Release pipeline now automated.** Tag `v*.*.*` push on `main` triggers
  the `release.yml` workflow, which runs tests, publishes both packages
  with `--provenance`, and creates a GitHub Release from the matching
  `CHANGELOG.md` section. No more manual `npm publish` or shared tokens.
- **npm provenance attestation** is now emitted for every release.
  Visible as a badge on the npm package page linking to the exact
  GitHub commit that built the tarball.
- Workflow binds to GitHub environment `N8NCTL` reading
  `secrets.N8NCTL_TOKEN` (environment-scoped, narrower than repo-level).

### Internal

- Added `RELEASING.md` documenting the procedure and semver guidance.
- Added `npm audit --omit=dev` check to CI (warn-only).

## [0.2.0] — 2026-04-23

Security hardening + reliability + test coverage + DX improvements. Motivated
by a post-v0.1.0 external audit plus meta-challenge of the audit itself.

### Added

#### `@trngthnh369/n8nctl`

- **`--redact` flag** for `workflow get` and `workflow list`. Scrubs `pinData`
  (cached API responses with user PII), `credentials.<type>.name` (keeps `id`
  for reference), and `webhookId` at any nesting depth.
- **Webhook auth passthrough** on `workflow trigger-webhook`:
  - `--auth-bearer <token>` → `Authorization: Bearer <token>`
  - `--auth-basic <user:pass>` → HTTP Basic
  - `--auth-header "Name: Value"` (repeatable) → custom headers
  - Warns when webhook node has `authentication != "none"` but no auth flag
    was supplied.
- **`workflow watch`** — tail executions in realtime via polling. Optional
  `--workflow <id>` / `--status <s>` / `--interval <ms>` filters.
- **`n8nctl completion <shell>`** — generate bash / zsh / fish / powershell
  completion scripts.
- **Stdin support** for `workflow create -` / `workflow update <id> -` —
  kubectl-style pipe-friendly deployments.
- **Doctor write-permission probe** — `doctor` now posts + deletes a probe
  tag to distinguish read-only vs read-write API keys. Reveals whether the
  key can also DELETE tags. Probe name stays under 19 chars to respect n8n's
  (undocumented) 24-char tag name limit.
- **N8NCTL_TRACE=1** env var — logs every HTTP request with method, URL,
  status, attempt number. Useful for debugging retry behavior.

#### `@trngthnh369/n8n-workflow-validator`

- **13 new secret patterns** (Layer 4): GitHub `ghp_/gho_/ghu_/ghs_/ghr_`,
  Stripe `sk_live_/rk_live_`, OpenAI `sk-`, Anthropic `sk-ant-`, PEM private
  keys (RSA/EC/DSA/OPENSSH/PGP/ENCRYPTED/generic), OpenSSH key header,
  AWS session token `ASIA`.
- **`conditionalRequired` schema enforcement** (Layer 6): types like
  `pythonCode: { when: { language: 'python' }, type: 'string' }` are now
  checked. New error codes `E065` (missing) and `E066` (wrong type).

### Changed

- **`workflow trigger-webhook` uses `N8nClient` infrastructure** instead of
  a raw axios call — inherits retry, backoff, timeout, insecure handling,
  and N8NCTL_TRACE logging. Transient 502/503 during n8n restart now auto-
  retry.
- **Clock skew buffer extended 2s → 30s** in `waitForExecution`. Absorbs
  NTP drift between client and server clocks (Windows dev machines,
  hibernating VMs, Docker hosts without time sync).
- **Webhook path encoding** now splits on `/` and encodes each segment
  separately — preserves multi-segment paths like `api/users` instead of
  turning `/` into `%2F`.
- **Handlebars templates are sandboxed per-render** via `Handlebars.create()`
  instead of mutating a global singleton. Also catches render errors and
  surfaces them as `ValidationError`.
- **Error messages are ANSI-scrubbed** before stderr output — untrusted API
  error bodies can no longer inject terminal escape sequences.
- **User-Agent** bumped to `n8nctl/0.2.0`.

### Security

- **npm provenance enabled.** Both published packages now carry Sigstore
  provenance attestation — verifiable supply chain from GitHub Actions to
  npm. Badge visible on the npm package page.

### Internal

- Test suite expanded from 31 → 140 tests (+109).
  - `lib/api.ts`: 0% → **90.62%** line coverage (retry, backoff, pagination,
    webhook, error paths).
  - `lib/config.ts`: 0% → **87.23%** (incl. concurrent-write serialization).
  - `lib/execution.ts`: 0% → **96.72%**.
  - `lib/keyring.ts`: 0% → **93.87%** (incl. Linux no-libsecret simulation).
  - Validator Layer 2/3: 16 new tests covering each E020–E030, E040.
- `src/lib/stdin.ts` — shared kubectl-style `readJsonSource()` helper.
- `src/lib/workflow-body.ts` — added `suggestTimeout(bytes)` for large
  payload auto-extension (future wiring).
- `@vitest/coverage-v8` + `axios-mock-adapter` added as devDeps.

## [0.1.1] — 2026-04-23

### Fixed

#### `@trngthnh369/n8nctl`

- **`--no-keyring` flag now actually works.** Commander maps `--no-keyring` to `{ keyring: false }`,
  not `{ noKeyring: true }`. Previous code checked `opts.noKeyring` (always `undefined`), so the flag
  was silently ignored and credentials were always written to keyring regardless of user intent.
  (Bug verified reproducible; regression test added.)
- **Keyring verify-after-write.** `setPassword` now round-trips with `getPassword` before returning
  success. On Linux hosts without `libsecret-1` (headless servers, Docker containers), keytar could
  previously report success but fail to persist; now the round-trip check forces fallback to
  plaintext config with a clear warning.
- **`workflow create` / `workflow update` now strip read-only fields consistently** with
  `workflow restore` / `workflow import`. Fields stripped: `id`, `createdAt`, `updatedAt`,
  `versionId`, `active`, `tags`. Consolidated into `src/lib/workflow-body.ts`.
- **`workflow trigger-webhook` warns when multiple webhook nodes exist** and `--path` was not
  specified. Previously it silently picked the first node, which could mean firing the wrong
  webhook. Now it emits a `warning:` to stderr and suggests `--path <path>` to disambiguate.
- **Bumped `axios` from `^1.7.7` to `^1.7.9`** — addresses CVE-2024-57965 (memory allocation DOS).

#### `@trngthnh369/n8n-workflow-validator`

- **Null-guard for `nodes[i]`.** Previously a workflow with `nodes: [null]` or nodes containing
  non-object values (string, number, nested array) would throw `TypeError: Cannot read properties
  of null (reading 'id')` instead of reporting a validation error. New error code `E009`.

### Added

- `workflow create` now supports `--dry-run` (parity with `update`, `delete`, `tag`, `restore`,
  `import`).

### Internal

- `src/lib/workflow-body.ts` — shared `stripReadOnlyFields()` helper (DRY).
- Regression test suites (`tests/regression.test.ts` in both packages) pin each bug with a failing
  test that would fail if the fix is reverted.
- 31 tests total now pass (was 22).

## [0.1.0] — 2026-04-23

Initial public release.

- 28+ leaf commands across 7 noun groups (workflow, execution, credential, tag, auth, config,
  profile) + top-level `doctor`.
- Layered auth: `--api-key` flag → `N8N_API_KEY` env → OS keyring (keytar) → config file.
- Multi-instance profiles (dev/staging/prod) with one-shot `--profile <name>` override.
- Universal output trio: `--json` / `--jq <expr>` / `--template <handlebars>`.
- TTY-aware: pretty table in terminal, JSON when piped.
- Typed exit codes (0 OK / 1 API / 2 auth / 3 validation / 4 network / 5 internal).
- Retry + exponential backoff with `Retry-After` header support.
- Offline workflow validation via `@trngthnh369/n8n-workflow-validator` (6 layers).
- Atomic config writes via `proper-lockfile`.
- `--dry-run` for destructive operations.
- `--insecure` flag + per-profile `insecure: true` for self-signed TLS.
