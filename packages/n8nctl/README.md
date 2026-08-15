# @trngthnh369/n8nctl

> 🇻🇳 **[Đọc bằng tiếng Việt](./README.vi.md)**

> kubectl for n8n. A friendly CLI for managing n8n workflows via REST API — inspired by `gh`, `kubectl`, and `gws`.

[![npm version](https://img.shields.io/npm/v/@trngthnh369/n8nctl.svg)](https://www.npmjs.com/package/@trngthnh369/n8nctl)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](../../LICENSE)

## Features

- Full workflow lifecycle (`list`, `get`, `create`, `update`, `activate`, `run`, `verify`, `promote`, `backup`, `rollback`, `delete`)
- Trigger workflows: `workflow run` (headless via internal /rest) and `workflow trigger-webhook`
- Execution inspection (`execution list/get/retry`) with logs
- Layered auth: `--api-key` → `$N8N_API_KEY` → OS keyring (keytar) → config file
- **Multi-instance profiles** (dev/staging/prod) — switch with one command
- Universal `--json` / `--jq` / `--template` output trio (gh-style)
- TTY-aware: pretty table in terminal, JSON when piped
- Typed exit codes (0 OK, 1 API, 2 auth, 3 validation, 4 network, 5 internal, 6 assertion-failed)
- Method-aware retry with exponential backoff + `Retry-After` respect (writes never double-fire)
- Offline workflow validation via [`@trngthnh369/n8n-workflow-validator`](../n8n-workflow-validator)
- n8n MCP helpers: derive `<host>/mcp-server/http`, generate streamable-HTTP client config, and compare official MCP/CLI/n8nctl responsibilities

## Install

```bash
npm install -g @trngthnh369/n8nctl
```

Requires Node.js 20+.

## Quick start

```bash
# 1. One-time auth setup (stores key in OS keyring)
n8nctl auth login

# 2. List workflows
n8nctl workflow list

# 3. Back up a workflow
n8nctl workflow backup 42 -o ./backups/

# 4. Deploy from file (with offline validation)
n8nctl workflow validate ./my-workflow.json
n8nctl workflow create ./my-workflow.json
n8nctl workflow activate 58

# 5. Trigger execution
#    - a webhook workflow: POST to its webhook URL
n8nctl workflow trigger-webhook 58 --data '{"input": "value"}'
#    - a manual/scheduled/sub-workflow: run headless via internal /rest (needs session login)
n8nctl auth login --session --email you@example.com
n8nctl workflow run 58 --wait

# 6. Inspect last execution
n8nctl execution list --workflow 58 --limit 1
n8nctl execution get <execution-id> --logs

# 7. Prepare n8n instance MCP for an agent client
n8nctl mcp info --json
n8nctl mcp config --client claude --server-name n8n-prod --token-env N8N_MCP_TOKEN
```

## Command reference

See [the umbrella README](../../README.md) for the full monorepo context.

### workflow
| Command | Description |
|---------|-------------|
| `workflow list [--active] [--tag <t>]` | List workflows |
| `workflow get <id> [-o <file>]` | Fetch workflow JSON |
| `workflow create <file>` | Create from JSON file |
| `workflow update <id> <file>` | Update from JSON file |
| `workflow activate <id>` | Activate workflow |
| `workflow deactivate <id>` | Deactivate workflow |
| `workflow run <id> [--trigger <n>] [--wait]` | Execute headless via internal /rest (needs `auth login --session`) |
| `workflow trigger-webhook <id> [--data <json>]` | POST to a workflow's webhook URL |
| `workflow verify <id> [--expect <file>]` | Gate an execution against expectations (exit 6 on failed assertion) |
| `workflow backup <id> [-o <dir>]` | Backup to timestamped file |
| `workflow archive <id>` | Archive a workflow (reversible; forces it inactive) — the safe alternative to `delete` |
| `workflow unarchive <id>` | Restore an archived workflow (leaves it inactive) |
| `workflow delete <id> [--yes]` | Delete workflow (permanent) |
| `workflow validate <file> [--strict]` | Offline 7-layer validation |

> This table covers the common verbs. Run `n8nctl workflow --help` for the full
> lifecycle set (`normalize`, `scaffold`, `diff`, `restore`, `rollback`,
> `promote`, `export-all`, `import`, `watch`, `schema`, `refresh`, `status`, `tag`).

### execution
| Command | Description |
|---------|-------------|
| `execution list [--workflow <id>] [--limit <n>]` | List executions |
| `execution get <id> [--logs]` | Get execution details |
| `execution retry <id>` | Retry a failed execution (internal /rest — needs `auth login --session`) |

### credential
| Command | Description |
|---------|-------------|
| `credential list` | List credentials (no values) |
| `credential schema <type>` | Fetch the schema (required fields) for a credential type |
| `credential create <file> [--no-validate]` | Create a credential from a JSON file (`{name, type, data}`); validates against `/credentials/schema/<type>` unless `--no-validate` |

### auth
| Command | Description |
|---------|-------------|
| `auth login [--host <url>] [--no-keyring]` | Interactive auth setup |
| `auth status` | Show active auth + connectivity test |
| `auth logout [--profile <name>]` | Remove stored credentials |

### config
| Command | Description |
|---------|-------------|
| `config get <key>` | Get config value |
| `config set <key> <value>` | Set config value |
| `config list` | Show all config |

### profile
| Command | Description |
|---------|-------------|
| `profile list` | List profiles |
| `profile add <name> --host <url>` | Add profile |
| `profile switch <name>` | Set active profile |
| `profile remove <name>` | Remove profile |

### mcp
| Command | Description |
|---------|-------------|
| `mcp info [--endpoint <url>] [--token-env <name>]` | Show the derived n8n MCP endpoint, official MCP/CLI positioning, and safety guardrails |
| `mcp config --client <claude\|cursor\|codex\|generic>` | Generate a streamable-HTTP MCP client config snippet without exposing `N8N_API_KEY` |
| `mcp compare` | Compare official n8n MCP, official n8n CLI/API client, and n8nctl responsibilities |

## Auth resolution order

1. `--api-key <token>` flag (ephemeral, for CI)
2. `$N8N_API_KEY` + `$N8N_HOST` env vars (legacy compat)
3. OS keyring via `keytar` (default for interactive installs)
4. `~/.config/n8nctl/config.yml` / `%APPDATA%\n8nctl\config.yml` (plaintext fallback, warned)

## Multi-instance profiles

```bash
n8nctl profile add prod --host https://n8n-prod.example.com
n8nctl profile add dev  --host https://n8n-dev.example.com
n8nctl auth login --profile prod
n8nctl auth login --profile dev
n8nctl profile switch prod
n8nctl workflow list              # hits prod
n8nctl --profile dev workflow list # one-shot override
```

## Output format trio

```bash
n8nctl workflow list                              # TTY: pretty table
n8nctl workflow list | cat                        # piped: JSON
n8nctl workflow list --json                       # force JSON
n8nctl workflow list --jq '.[] | select(.active)' # jq query
n8nctl workflow list --template '{{#each this}}{{id}}  {{name}}{{newline}}{{/each}}'
```

State-changing commands (`activate`, `archive`, `delete`, `tag create`, `variable set`, …)
report a status line instead of a document, so they behave slightly differently:

```bash
n8nctl workflow activate 58                # ✓ activated workflow 58 "wf"  (stdout)
n8nctl workflow activate 58 | cat          # same text — piping does NOT switch to JSON
n8nctl workflow activate 58 --json         # {"id":"58","name":"wf","active":true} on stdout,
                                           #   status line on stderr so stdout stays pure
n8nctl workflow archive 58 --jq '.id'      # "58"
n8nctl workflow delete 58 --dry-run --json # preview as JSON, flagged "dryRun": true
```

The status line stays on stdout by default *on purpose*: switching piped output to JSON
would break every existing script that greps it. Pass an explicit flag to opt in.

## Exit codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | API error (4xx/5xx from n8n) |
| 2 | Auth error |
| 3 | Validation error (incl. bad CLI arguments / unknown commands) |
| 4 | Network error |
| 5 | Internal error |
| 6 | Assertion failed — the command ran but a stated expectation failed (`workflow verify`, `--expect-status`). Distinct from infra errors so agents can tell "broken pipeline" from "failed assertion". |

## Self-signed TLS

For development instances with self-signed certificates, use the scoped
`--insecure` flag (or per-profile `insecure: true`), which disables TLS
verification for n8nctl's requests only and warns when active:

```bash
n8nctl --insecure workflow list
n8nctl profile add dev --host https://n8n-dev.local --insecure
```

Prefer this over `NODE_TLS_REJECT_UNAUTHORIZED=0`, which disables TLS
verification for the entire Node process.

## License

MIT
