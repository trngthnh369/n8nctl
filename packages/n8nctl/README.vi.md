# @trngthnh369/n8nctl

> 🇬🇧 **[Read in English](./README.md)**

> kubectl cho n8n — CLI quản lý n8n workflows qua REST API. Lấy cảm hứng từ `gh`, `kubectl`, và `gws`.

[![npm version](https://img.shields.io/npm/v/@trngthnh369/n8nctl.svg)](https://www.npmjs.com/package/@trngthnh369/n8nctl)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](../../LICENSE)

## Tính năng

- Quản lý workflow đầy đủ (list, get, create, update, activate, run, verify, promote, backup, rollback, delete)
- Kiểm tra execution (list, get, retry, wait, last-error)
- Auth phân lớp: `--api-key` → `$N8N_API_KEY` → OS keyring (keytar) → config file
- **Multi-instance profiles** (dev/staging/prod) — switch bằng 1 lệnh
- Output trio: `--json` / `--jq` / `--template` (giống `gh`)
- TTY-aware: bảng đẹp khi ở terminal, JSON khi pipe
- Typed exit codes (0 OK, 1 API, 2 auth, 3 validation, 4 network, 5 internal, 6 assertion-failed)
- Retry + exponential backoff + tôn trọng `Retry-After` header
- Validate workflow offline qua [`@trngthnh369/n8n-workflow-validator`](../n8n-workflow-validator)
- n8n MCP helpers: suy ra `<host>/mcp-server/http`, sinh config streamable HTTP cho MCP client, và phân vai official MCP / official CLI / n8nctl

## Cài đặt

```bash
npm install -g @trngthnh369/n8nctl
```

Yêu cầu Node.js 20+.

## Khởi động nhanh

```bash
# 1. Setup auth (lưu key vào OS keyring)
n8nctl auth login

# 2. List workflows
n8nctl workflow list

# 3. Backup workflow
n8nctl workflow backup 42 -o ./backups/

# 4. Deploy từ file (có validate offline)
n8nctl workflow validate ./my-workflow.json
n8nctl workflow create ./my-workflow.json
n8nctl workflow activate 58

# 5. Trigger execution (cho webhook workflows)
n8nctl workflow trigger-webhook 58 --data '{"input": "value"}' --wait

# 6. Xem execution gần nhất
n8nctl execution list --workflow 58 --limit 1
n8nctl execution get <execution-id> --logs

# 7. Chuẩn bị n8n MCP cho Claude/Codex/Cursor
n8nctl mcp info --json
n8nctl mcp config --client codex --server-name n8n-prod --token-env N8N_MCP_TOKEN
```

## Tham chiếu commands

### workflow
| Command | Mô tả |
|---------|-------|
| `workflow list [--active] [--tag <t>] [--search <s>] [--all]` | Liệt kê workflows |
| `workflow get <id> [-o <file>]` | Lấy workflow JSON |
| `workflow create <file>` | Tạo từ JSON file |
| `workflow update <id> <file>` | Cập nhật từ JSON file |
| `workflow activate <id>` | Kích hoạt workflow |
| `workflow deactivate <id>` | Tắt workflow |
| `workflow trigger-webhook <id> --wait` | Fire webhook + đợi kết quả |
| `workflow backup <id> [-o <dir>]` | Backup ra file có timestamp |
| `workflow archive <id>` | Archive workflow (đảo ngược được; tự tắt active) — thay cho `delete` |
| `workflow unarchive <id>` | Khôi phục workflow đã archive (vẫn để inactive) |
| `workflow delete <id> [--yes]` | Xoá workflow (vĩnh viễn) |
| `workflow validate <file> [--strict]` | Validate offline 6 lớp |
| `workflow diff <id> <file>` | So sánh local vs deployed |
| `workflow restore <backup.json>` | Khôi phục từ backup |
| `workflow tag <id> <names...>` | Gán tag |
| `workflow export-all -o <dir>` | Backup toàn bộ workflows |
| `workflow import <dir> [--force]` | Import hàng loạt từ thư mục |

### execution
| Command | Mô tả |
|---------|-------|
| `execution list [--workflow <id>]` | Liệt kê executions |
| `execution get <id> [--logs]` | Chi tiết execution |
| `execution retry <id>` | Retry execution lỗi |
| `execution wait <id> --timeout` | Đợi execution kết thúc |
| `execution last-error --workflow <id>` | Lấy lỗi gần nhất |

### credential / tag / auth / config / profile / doctor
```bash
n8nctl credential list [--type <t>]     # derive từ workflow nodes
n8nctl credential schema <type>         # schema của credential type
n8nctl credential create <file>         # tạo credential từ file JSON ({name,type,data})
n8nctl credential create <file> --no-validate  # bỏ qua pre-flight schema check
n8nctl tag list
n8nctl tag create <name>
n8nctl auth {login|status|logout}
n8nctl profile {list|add|switch|remove}
n8nctl config {get|set|list}
n8nctl doctor                           # health check toàn diện
```

### mcp
| Command | Mô tả |
|---------|-------|
| `mcp info [--endpoint <url>] [--token-env <name>]` | Hiển thị endpoint MCP, phân vai official MCP/CLI và guardrails an toàn |
| `mcp config --client <claude\|cursor\|codex\|generic>` | Sinh snippet streamable HTTP cho MCP client, không lộ `N8N_API_KEY` |
| `mcp compare` | So sánh trách nhiệm giữa n8n MCP chính thức, n8n CLI/API client chính thức và n8nctl |

## Auth resolution (thứ tự ưu tiên)

1. `--api-key <token>` flag (tạm thời, dùng cho CI)
2. `$N8N_API_KEY` + `$N8N_HOST` env vars (tương thích skill cũ)
3. OS keyring qua `keytar` (default sau khi `auth login`)
4. File `~/.config/n8nctl/config.yml` (hoặc `%APPDATA%\n8nctl\config.yml` trên Windows)

## Multi-instance profiles

```bash
n8nctl profile add prod --host https://n8n-prod.example.com
n8nctl profile add dev  --host https://n8n-dev.example.com
n8nctl auth login --profile prod
n8nctl auth login --profile dev
n8nctl profile switch prod
n8nctl workflow list                       # hit prod
n8nctl --profile dev workflow list         # một lần override sang dev
```

## Output format linh hoạt

```bash
n8nctl workflow list                              # TTY: bảng đẹp
n8nctl workflow list | cat                        # piped: JSON
n8nctl workflow list --json                       # ép JSON
n8nctl workflow list --jq '.[] | select(.active)' # jq query
n8nctl workflow list --template '{{#each this}}{{id}}  {{name}}{{newline}}{{/each}}'
```

Lệnh đổi state (`activate`, `archive`, `delete`, `tag create`, `variable set`, …) in ra
một dòng trạng thái chứ không phải document, nên hành vi hơi khác:

```bash
n8nctl workflow activate 58                # ✓ activated workflow 58 "wf"  (stdout)
n8nctl workflow activate 58 | cat          # vẫn là text — pipe KHÔNG tự đổi sang JSON
n8nctl workflow activate 58 --json         # stdout ra JSON sạch, dòng trạng thái sang stderr
n8nctl workflow archive 58 --jq '.id'      # "58"
n8nctl workflow delete 58 --dry-run --json # preview dạng JSON, có cờ "dryRun": true
```

Dòng trạng thái mặc định vẫn ở stdout là **có chủ đích**: đổi output khi pipe sang JSON sẽ
phá mọi script đang grep nó. Muốn JSON thì truyền cờ tường minh.

## Exit codes

| Code | Ý nghĩa |
|------|---------|
| 0 | Thành công |
| 1 | Lỗi API (4xx/5xx từ n8n) |
| 2 | Lỗi auth |
| 3 | Lỗi validation |
| 4 | Lỗi network |
| 5 | Lỗi nội bộ |
| 6 | Assertion failed — lệnh chạy xong nhưng kỳ vọng không đạt (`workflow verify`, `--expect-status`) |

## Self-signed TLS

Cho dev instance dùng self-signed cert:

```bash
# Tạm thời cho 1 lệnh
n8nctl --insecure workflow list

# Vĩnh viễn per-profile
n8nctl profile add dev --host https://dev.internal --insecure

# Không khuyến nghị: env var Node native (tắt TLS cho TOÀN BỘ process, không chỉ n8nctl)
export NODE_TLS_REJECT_UNAUTHORIZED=0
```

## License

MIT
