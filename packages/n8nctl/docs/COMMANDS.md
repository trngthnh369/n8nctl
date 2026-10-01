# n8nctl — Command Reference

> Auto-generated from the Commander tree by `scripts/gen-command-docs.mjs`.
> Do not edit by hand — run `node scripts/gen-command-docs.mjs` after changing commands.

## audit

Generate the n8n security audit report (credentials risk, abandoned workflows, instance risks). Read-only: POST /audit only generates the report.

### `audit`

Generate the n8n security audit report (credentials risk, abandoned workflows, instance risks). Read-only: POST /audit only generates the report.

  - `--categories <list>` — Comma-separated subset of: credentials, database, nodes, filesystem, instance
  - `--days-abandoned <n>` — Days without execution before a workflow counts as abandoned (default: n8n server default 90)

## auth

Manage authentication and profiles

### `auth login`

Configure credentials interactively (stored in OS keyring by default)

  - `--host <url>` — n8n host URL (non-interactive)
  - `--profile <name>` — Profile name (default: "default")
  - `--api-key <token>` — API key (non-interactive)
  - `--no-keyring` — Store key in config file instead of OS keyring
  - `--insecure` — Store profile with TLS verification disabled (self-signed dev instances)
  - `--session` — Configure internal /rest session auth (email + password) for `workflow run`
  - `--email <addr>` — n8n login email (session mode, non-interactive)
  - `--cookie-only` — Session mode: do NOT store password; re-auth on cookie expiry (higher security)

### `auth logout`

Remove stored credentials for a profile

  - `--profile <name>` — Profile to remove (default: active)

### `auth status`

Show active authentication and verify connectivity

## catalog

Manage the offline validator catalog synced from an instance's live node types

### `catalog reset`

Remove the synced catalog for the active profile (validation reverts to the bundled catalog)

### `catalog show`

Show the synced validator catalog for the active profile (metadata + node count)

### `catalog sync`

Generate an offline validator catalog from THIS instance's live node types (/types/nodes.json, incl. community nodes), so `workflow validate` param-checks against the real node set instead of the 36-node bundled snapshot. Requires `n8nctl auth login --session`. Stored per profile.

  - `--refresh` — Force refetch the live node catalog (bypass the 24h cache)

## completion

Generate a shell completion script (reflects the live command tree)

### `completion <shell>`

Generate a shell completion script (reflects the live command tree)

## config

Manage n8nctl configuration

### `config get <key>`

Get a config value

### `config list`
*aliases: ls*

Show all config values

### `config set <key> <value>`

Set a config value

## credential (cred)

Manage credentials (list/inspect read-only; create from JSON file)

### `credential create <file>`

Create a credential from a JSON file (use "-" for stdin)

  - `--no-validate` — Skip schema validation against /credentials/schema/<type> before POST

### `credential delete <id>`
*aliases: rm*

Delete a credential

  - `-y, --yes` — Skip confirmation prompt

### `credential list`
*aliases: ls*

List credentials discovered across all workflows (n8n Public API does not have a GET /credentials endpoint; we derive from nodes).

  - `--type <type>` — Filter by credential type (e.g. "httpHeaderAuth")

### `credential schema <type>`

Fetch the schema (required fields) for a credential type

### `credential transfer <id>`

Move a credential to another project (licensed: Projects)

  - `--to <projectId>` — destination project ID

## doctor

Run an end-to-end health check (env, config, keyring, API connectivity, permissions). Use --verbose for server version, latency, and workflow/execution stats.

### `doctor`

Run an end-to-end health check (env, config, keyring, API connectivity, permissions). Use --verbose for server version, latency, and workflow/execution stats.

  - `--verbose` — Include server version, latency p50, workflow/execution stats, rate-limit headers

## execution (exec)

Inspect and manage workflow executions

### `execution delete <id>`
*aliases: rm*

Delete an execution record (useful for cleaning up between agent test runs)

  - `-y, --yes` — Skip confirmation prompt

### `execution get <id>`

Get execution details by ID

  - `--logs` — Include full execution data (logs / node outputs)

### `execution last-error`

Fetch the most recent failed execution for a workflow

  - `--workflow <id>` — workflow ID
  - `--summary` — Print short summary instead of full execution JSON

### `execution list`
*aliases: ls*

List recent executions

  - `--workflow <id>` — Filter by workflow ID
  - `--status <status>` — Filter by status (success|error|waiting|canceled|running)
  - `--limit <n>` — Maximum results (default 20)

### `execution logs <id>`

Compact per-node view of an execution (status, duration, item counts, errors). Replaces --jq gymnastics in the debug loop. IO is redacted by default.

  - `--node <name>` — Show only this node
  - `--errors-only` — Show only failed node runs
  - `--io-data` — Include per-node output items (redacted, trimmed)
  - `--unsafe-raw-io` — Disable redaction of IO data (output may contain live secrets)

### `execution retry <id>`

Retry a failed execution (uses the internal /rest API — requires `n8nctl auth login --session`)

  - `--load-workflow` — Reload the current saved workflow instead of the execution snapshot

### `execution stats`

Aggregate executions: per-workflow status counts + failure rate and duration p50/p95 over a window, stuck running/waiting executions (scanned separately, not limited by the window, capped at 500 per status newest first: when cut, stuck holds the newest and a warning says so), and the top 50 error clusters (node + normalized message). Read-only; error text is redacted.

  - `--workflow <id>` — Filter to one workflow
  - `--since <when>` — Window start: a duration ago (30m, 24h, 7d) or an ISO-8601 time with Z or an offset, or a YYYY-MM-DD date (UTC); client-side cutoff
  - `--limit <n>` — Max executions scanned for the window, newest first (default 1000, max 20000)
  - `--stuck-after <duration>` — Flag running/waiting executions older than this; a unit is required (e.g. 30m, 2h; default 1h)

### `execution wait <id>`

Poll until an execution reaches a terminal state (success/error/canceled/crashed)

  - `--timeout <ms>` — Max wait time in ms (default: 120000)
  - `--poll <ms>` — Polling interval in ms (default: 2000)

## mcp

Plan and configure n8n instance-level MCP access without leaking API keys

### `mcp compare`

Compare official n8n MCP, official n8n CLI, and n8nctl responsibilities

### `mcp config`

Generate a MCP client config snippet for n8n instance-level MCP

  - `--client <client>` — Target MCP client config shape
  - `--endpoint <url>` — Override MCP endpoint (default: <host>/mcp-server/http)
  - `--token-env <name>` — Environment variable that stores the MCP bearer token
  - `--server-name <name>` — MCP server name in generated client config

### `mcp info`

Show n8n MCP endpoint, official CLI positioning, and production safety guardrails

  - `--endpoint <url>` — Override MCP endpoint (default: <host>/mcp-server/http)
  - `--token-env <name>` — Environment variable that stores the MCP bearer token

## node

Inspect node types from THIS instance’s live catalog (incl. community nodes)

### `node describe <type>`
*aliases: show*

Show a node type schema (params, versions, credentials) from the live catalog

  - `--property <name>` — Show only this property
  - `--required-only` — Show only required properties
  - `--refresh` — Force refetch the catalog (bypass the 24h cache)

### `node list`
*aliases: ls*

List node types available on THIS instance (live catalog, incl. community nodes)

  - `--search <text>` — Filter by name/displayName substring
  - `--community` — Only community/langchain nodes (non n8n-nodes-base)
  - `--refresh` — Force refetch the catalog (bypass the 24h cache)

### `node search <text>`

Search node types by name/displayName (sugar for `node list --search`)

  - `--community` — Only community/langchain nodes
  - `--refresh` — Force refetch the catalog (bypass the 24h cache)

## profile

Manage multi-instance profiles

### `profile add <name>`

Add a new profile (credentials added via `n8nctl auth login --profile <name>`)

  - `--host <url>` — n8n host URL
  - `--insecure` — Store profile with TLS verification disabled (dev instances only)

### `profile list`
*aliases: ls*

List configured profiles

### `profile remove <name>`
*aliases: rm*

Remove a profile (and its stored credentials)

  - `-y, --yes` — Skip confirmation

### `profile switch <name>`
*aliases: use*

Set the active profile

## project

Manage projects (licensed n8n feature)

### `project add-user <projectId> <userId>`

Add a user to a project (licensed: Projects)

  - `--role <role>` — project role (project:admin | project:editor | project:viewer)

### `project create <name>`

Create a project (licensed: Projects)

### `project delete <id>`
*aliases: rm*

Delete a project (licensed: Projects)

  - `-y, --yes` — Skip confirmation prompt

### `project list`
*aliases: ls*

List projects

### `project remove-user <projectId> <userId>`

Remove a user from a project (licensed: Projects)

  - `-y, --yes` — Skip confirmation prompt

### `project update <id> <name>`

Rename a project (licensed: Projects)

## source-control (sc)

Source control operations (licensed n8n feature)

### `source-control pull`

Pull workflows/credentials/variables from the connected git branch. Takes a MANDATORY pre-pull snapshot bundle of all workflows first (rollback point).

  - `--force` — Overwrite local instance changes (louder confirm)
  - `-y, --yes` — Skip the confirmation prompt (required in non-TTY mode)
  - `--backup-dir <dir>` — Where to write the pre-pull bundle (default: ./_backups)
  - `--skip-backup` — DANGEROUS: skip the pre-pull snapshot bundle

## tag

Manage tags on the active instance

### `tag create <name>`

Create a new tag

### `tag delete <id>`
*aliases: rm*

Delete a tag

  - `-y, --yes` — Skip confirmation prompt

### `tag list`
*aliases: ls*

List tags on the active instance

  - `--limit <n>` — Max results (default 100)
  - `--all` — Fetch all via pagination

### `tag update <id> <name>`

Rename a tag

## user

Manage instance users (writes are licensed features)

### `user delete <id>`
*aliases: rm*

Delete a user (licensed: user management)

  - `-y, --yes` — Skip confirmation prompt

### `user get <id>`

Get a user by id or email

### `user invite <emails>`

Invite one or more users by email (licensed: user management)

  - `--role <role>` — global role for the invitees (global:admin | global:member)

### `user list`
*aliases: ls*

List users

### `user role <id> <role>`

Change a user's global role (licensed: user management)

## variable (var)

Manage instance variables (licensed n8n feature)

### `variable delete <key>`
*aliases: rm*

Delete a variable by key or id (licensed feature)

### `variable list`
*aliases: ls*

List instance variables (licensed feature)

### `variable set <key> <value>`

Create or update a variable by key (licensed feature)

## workflow (wf)

Manage n8n workflows

### `workflow activate <id>`

Activate a workflow

### `workflow archive <id>`

Archive a workflow (reversible; use `unarchive` to restore). The safe alternative to `delete`.

### `workflow backup <id>`

Backup a workflow to a timestamped JSON file

  - `-o, --output <dir>` — Output directory (default: ./_backups)

### `workflow create <file>`

Create a workflow from a JSON file (use "-" for stdin)

  - `--activate` — Activate the workflow immediately after create (registers webhooks)
  - `--no-normalize` — Skip auto-normalize (UUID node ids + execution-log settings)
  - `--no-validate` — Skip pre-deploy workflow validation
  - `--validate-policy <p>` — Block on validation issues per policy (dev|ci|strict). Default: warn only.

### `workflow deactivate <id>`

Deactivate a workflow

### `workflow delete <id>`
*aliases: rm*

Delete a workflow

  - `-y, --yes` — Skip confirmation prompt

### `workflow deploy <file>`

One-shot deploy: normalize → validate → create-or-update (by name, or --id) → activate → optional trigger-registration check → optional run + verify gate. Exit 3 on validation/ambiguity, 6 on a failed gate or unregistered trigger.

  - `--id <id>` — Update this workflow ID instead of matching by name
  - `--create-only` — Fail if a same-name workflow already exists
  - `--update-only` — Fail if no same-name workflow exists (never create)
  - `--activate` — Activate after deploy
  - `--verify-triggers` — After activate, probe webhook URLs to confirm registration (⚠ fires the webhook once); exit 6 if not registered
  - `--run` — Run the workflow via /rest after deploy, then gate the execution
  - `--trigger <name>` — Trigger node name for --run (non-webhook)
  - `--expect <file>` — Expectation file for the gate (JSON/YAML, version: v1)
  - `--expect-fields <a,b,c>` — Gate: fields required non-null on the last node output
  - `--max-duration-ms <n>` — Gate: execution duration budget in ms
  - `--timeout <ms>` — Wait timeout for --run (default 120000)
  - `--no-normalize` — Skip auto-normalize
  - `--no-validate` — Skip validation
  - `--validate-policy <p>` — Validation policy dev|ci|strict (default ci — deploy blocks on failure)
  - `--rollback-on-fail` — On any post-write failure, restore the previous state (update) or deactivate the new workflow (create)
  - `--rollback-delete-created` — With --rollback-on-fail, DELETE a rolled-back created workflow instead of deactivating it
  - `--out-dir <dir>` — Write a deploy-report.json artifact

### `workflow diff <id> <file>`

Show differences between a local workflow JSON and the deployed version

  - `--full` — Print full JSON diff instead of summary

### `workflow export-all`

Backup every workflow on the instance to a directory (one JSON file per workflow)

  - `-o, --output <dir>` — Output directory (default: ./_backups/<timestamp>/)
  - `--active` — Export only active workflows
  - `--tag <tag>` — Filter by tag name
  - `--concurrency <n>` — Max parallel fetches (default: 5)

### `workflow get <id>`

Fetch a workflow by ID

  - `-o, --output <file>` — Write JSON to file instead of stdout
  - `--redact` — Scrub pinData, credential names, and webhook IDs before output

### `workflow import <dir>`

Import workflows from a directory (creates or updates)

  - `--force` — Overwrite existing workflows (default: skip)
  - `--activate` — Activate each imported workflow
  - `--concurrency <n>` — Max parallel imports (default: 3)
  - `--no-validate` — Skip pre-deploy workflow validation
  - `--validate-policy <p>` — Block on validation issues per policy (dev|ci|strict). Default: warn only.

### `workflow list`
*aliases: ls*

List workflows on the active n8n instance

  - `--active` — Show only active workflows
  - `--tag <tag>` — Filter by tag name
  - `--search <text>` — Case-insensitive substring match on workflow name
  - `--limit <n>` — Maximum results (default 100). Ignored with --all.
  - `--all` — Fetch ALL workflows across pages (auto-paginate)
  - `--redact` — Scrub pinData, credential names, and webhook IDs from each workflow

### `workflow normalize <file>`

Normalize a workflow JSON to n8n conventions (UUID node ids + execution-log settings) without changing behaviour. Use before validate/deploy, or to clean a Claude-generated file. Does NOT bump typeVersion (validator E072 warns instead).

  - `-o, --output <path>` — write normalized JSON to this path (default: stdout)
  - `-w, --write` — write back in place (overwrites <file>)

### `workflow promote <id>`

Promote a workflow to another instance (dev → prod). Remaps credential references to the TARGET instance: auto-matches by type+name ONLY when exactly one target credential matches; ambiguous/missing refs block (no silent mis-binding). Sends only the 4-field whitelist.

  - `--to <profile>` — destination profile (n8nctl profile name)
  - `--from <profile>` — source profile (default: the active/--profile instance)
  - `--map <file>` — credential mapping file (JSON array: {sourceId|type+name, targetId})
  - `--allow-unmapped` — proceed even if some credentials have NO target match (keeps source refs; ambiguous still blocks)
  - `--out-dir <dir>` — write promoted JSON + mapping report + target diff as artifacts
  - `--activate` — activate the workflow on the target after promotion
  - `--no-validate` — Skip pre-promote workflow validation
  - `--validate-policy <p>` — Block on validation issues per policy (dev|ci|strict). Default: warn only.

### `workflow refresh <id>`

Cycle a workflow active state (deactivate → wait → activate) to nudge the n8n webhook/schedule router into re-registering handlers after an API update. NOTE: on single-main n8n this re-registers; on queue mode or a separate webhook process the in-process router may NOT pick it up — only a UI "Save" (or n8n restart) is guaranteed to register webhook/cron triggers.

  - `--delay <ms>` — Pause between deactivate and activate (default: 500)

### `workflow restore <file>`

Restore a workflow from a backup JSON file (update or create)

  - `--id <id>` — Target workflow ID (default: use id from file)
  - `--activate` — Activate after restore

### `workflow rollback <id>`

Restore a workflow from its newest backup (or --to <file>) with a safety snapshot, diff preview, and confirm gate. Order: snapshot → select target (snapshot excluded) → diff → confirm → restore → verify → optional --reactivate.

  - `--to <file>` — Roll back to this exact backup file (default: newest matching backup)
  - `--backup-dir <dir>` — Backup directory to search (default: ./_backups)
  - `--reactivate` — Activate the workflow after restore
  - `-y, --yes` — Skip the confirmation prompt (required in non-TTY mode)

### `workflow run <id>`

Execute a workflow headless via the internal /rest "Execute Workflow" endpoint (session auth). The Public API has NO execute endpoint — use this for manual / scheduled / sub-workflow verification, or when the webhook router is stuck (n8n #21614). Requires `n8nctl auth login --session`.

  - `--trigger <name>` — Trigger node NAME to start from (required when a workflow has multiple triggers; pick a non-webhook trigger to avoid waiting for a webhook event)
  - `--wait` — Poll the resulting execution to a terminal state and report pass/fail (exit 1 on non-success)
  - `--timeout <ms>` — Wait timeout in ms (default 120000)

### `workflow scaffold`

Generate a normalize-clean, validator-clean workflow skeleton. Builtins: webhook, cron, manual; or pass a template FILE to rename+normalize it. Output is byte-stable across runs (deterministic node ids).

  - `--from <name|file>` — Builtin (webhook, cron, manual) or a JSON template file (default: manual). Named --from because --template is the global Handlebars-output flag.
  - `--name <name>` — Workflow name (default: "New Workflow")
  - `--webhook-path <path>` — Webhook path for the webhook template (default: slug of the name)
  - `-o, --output <file>` — Write to file instead of stdout

### `workflow schema`

Show JSON shape of a Workflow resource (default) or per-node parameter schema (with --node). Use this to discover field names before constructing workflow JSON — prevents agents from fabricating names.

  - `--node <type>` — Show schema for a specific node type (e.g. n8n-nodes-base.httpRequest, or short name like "http")
  - `--list` — List all node types in the offline catalog

### `workflow status <id>`

Show active state, tags, webhook URLs, and last execution for a workflow

  - `--exit` — Exit 0 if active, 1 if inactive, regardless of output mode

### `workflow tag <id> <tag-names>`

Assign tag(s) to a workflow (appends by default, use --replace to overwrite)

  - `--replace` — Replace all existing tags instead of appending
  - `--create` — Create tags that do not yet exist

### `workflow transfer <id>`

Move a workflow to another project (licensed: Projects)

  - `--to <projectId>` — destination project ID

### `workflow trigger-webhook <id>`
*aliases: trigger*

Trigger a workflow by hitting its webhook node URL (n8n Public API has no /execute endpoint — this is the correct way).

  - `--data <json>` — Inline JSON payload for the webhook body
  - `--file <path>` — Read payload from JSON file
  - `--method <verb>` — HTTP method (default: from webhook node config)
  - `--path <path>` — Override webhook path (useful when multiple webhook nodes exist)
  - `--test` — Use /webhook-test/ endpoint (workflow in "listen for test event" mode)
  - `--wait` — Wait for the newest execution to finish after triggering
  - `--timeout <ms>` — Timeout for --wait polling in ms (default: 120000)
  - `--auth-bearer <token>` — Send Authorization: Bearer <token>
  - `--auth-basic <user:pass>` — Send HTTP Basic auth (user:password)
  - `--auth-header <header>` — Send custom auth header "Name: Value". Repeatable.
  - `--expect-status <code>` — Assert the webhook responds with exactly this HTTP status (single-shot, no retry; mismatch exits 6)
  - `--capture <file>` — Write the webhook {status, body} to file (redacted by default)
  - `--unsafe-raw-io` — Disable redaction in --capture output (handle file as a secret)

### `workflow unarchive <id>`

Restore an archived workflow (leaves it inactive)

### `workflow update <id> <file>`

Update an existing workflow from a JSON file (use "-" for stdin)

  - `--activate` — Activate the workflow after update (registers webhooks)
  - `--no-normalize` — Skip auto-normalize (UUID node ids + execution-log settings)
  - `--no-validate` — Skip pre-deploy workflow validation
  - `--validate-policy <p>` — Block on validation issues per policy (dev|ci|strict). Default: warn only.

### `workflow validate <file>`

Validate a workflow JSON file locally (6-layer check)

  - `--strict` — Fail on MEDIUM-severity issues too (alias of --policy strict)
  - `--policy <p>` — Severity policy: dev (CRITICAL blocks) | ci (CRITICAL+HIGH, default) | strict (+MEDIUM). Named --policy because --profile is the global auth-profile flag.
  - `--fix` — Apply mechanical normalize fixes (node ids, log settings) in place, then validate

### `workflow verify <workflowId>`

Run the Cần+Đủ+Tốt gate against an execution: CẦN = finished, no node errors, last node produced output; ĐỦ = expected fields present; TỐT = duration budget. Exit 6 when the gate fails (infra errors stay 1-5). Replaces the external test-gate.js.

  - `--execution <id>` — Verify this specific execution instead of the latest
  - `--expect <file>` — Expectation file (JSON or YAML, `version: v1`)
  - `--expect-fields <a,b,c>` — ĐỦ: comma-separated fields required non-null on the last node first item
  - `--max-duration-ms <n>` — TỐT: duration budget in ms (warning unless failOnSlow in --expect file)
  - `--run` — Execute the workflow first via /rest session mode, then verify that execution
  - `--trigger <name>` — Trigger node name for --run (non-webhook trigger)
  - `--timeout <ms>` — Wait timeout for --run (default 120000)
  - `--capture <file>` — Write {report, execution} artifact to file (redacted by default)
  - `--unsafe-raw-io` — Disable redaction in --capture output (handle file as a secret)

### `workflow watch`

Tail executions in realtime (polls /executions, emits new rows as they arrive)

  - `--workflow <id>` — Filter to one workflow
  - `--status <s>` — Filter by status (error|success|running|waiting|canceled|crashed)
  - `--interval <ms>` — Poll interval in ms (default: 3000, min 1000)
