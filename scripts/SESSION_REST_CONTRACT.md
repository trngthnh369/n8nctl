# SESSION_REST_CONTRACT — n8n /rest internal API (session mode)

> **Phase 0 RAN 2026-06-09 on n8npc.khoahrv.id.vn (n8n 1.122.5).**
> Status: **POC INVALIDATES THE ORIGINAL FEATURE PREMISE — see findings.**

## ⚠️ PHASE 0 FINDINGS (decision-changing)

| Capability | Result on 1.122.5 (single-main, executionMode=regular) |
|---|---|
| Webhook register via **Public API** activate | ✓ **WORKS** — webhook 200 after create+activate AND after update-while-active. Memory `feedback_n8n_webhook_no_register_via_api` premise is **WRONG for webhooks on this version**. |
| Webhook E2E via existing `trigger-webhook` | ✓ works (webhook accepted + --wait) |
| `/rest/workflows/{id}/run` on **webhook** wf | ✗ returns `{waitingForWebhook:true}` — does NOT execute headless |
| `/rest/workflows/{id}/run` on **manual/non-webhook** wf | ✓ executionId returned (e.g. 60711) + **queryable via Public API** GET /executions/{id} → status=success |
| Session login | ✓ cookie `n8n-auth` Max-Age=604800 (7d), HttpOnly/Secure/SameSite=Lax, **no CSRF** |
| Cron register via Public API | **UNTESTED** (memory claim unverified for cron) |

**Conclusion:**
- `workflow save` (register webhook) → **NOT NEEDED** on 1.122.5 single-main. DROP.
- `workflow run` (session) → useful ONLY for **manual / sub-workflow / non-webhook** (Public API can't execute those). For webhook wf use existing `trigger-webhook`.
- Feature descopes massively: session-auth + `workflow run` (non-webhook only). No save, no queue-mode, no register-rewrite.
- **OPEN:** user's actual failing case + cron registration — need clarification before any build.

## Verified contract values (for the descoped `workflow run`)
- Login: `POST /rest/login` body `{email, emailOrLdapLoginId, password}` (sent both; 200) — cookie `n8n-auth` 7d, no CSRF needed.
- Whoami: `GET /rest/login` → 200 `{data:{email, role}}`.
- Run: `POST /rest/workflows/{id}/run` body `{workflowData: <full wf>}` → `{data:{executionId}}` for non-webhook; `{data:{waitingForWebhook:true}}` for webhook.
- Wait: executionId IS queryable via Public API `GET /api/v1/executions/{id}` → reuse `waitForExecution(factory.client())`.
- Exec mode: `executionMode=regular`, `isQueueModeEnabled=false` (single-main).

## Endpoint contract matrix (extend before adding any /rest-dependent command)

| Endpoint | Method | Auth | Body | Response (shape-guarded) | License | n8n tested | Notes |
|---|---|---|---|---|---|---|---|
| `/rest/login` | POST | none (mints cookie) | `{email, emailOrLdapLoginId, password}` | `set-cookie: n8n-auth`; `{data:{email,role}}` | — | 1.122.5 | 7d cookie, no CSRF |
| `/rest/login` | GET | cookie | — | `{data:{email,role}}` | — | 1.122.5 | whoami; 401 ⇒ re-login |
| `/rest/workflows/{id}` | GET | cookie | — | `{data:<workflow>}` or bare | — | 1.122.5 | shape-guarded via expectRestObject |
| `/rest/workflows/{id}/run` | POST | cookie | `{workflowData, triggerToStartFrom?}` — **never `runData`** | `{data:{executionId?, waitingForWebhook?}}` | — | 1.122.5 | webhook ⇒ waitingForWebhook |
| `/rest/executions/{id}` | GET | cookie | — | `{data:<execution>}` or bare | — | 1.122.5 | poll to terminal |
| `/rest/executions/{id}/retry` | POST | cookie | `{loadWorkflow?: boolean}` — body OPTIONAL (omit ⇒ retry from saved exec data; `true` ⇒ reload saved workflow) | `{data:<new execution>}` or bare | — | **RE-VERIFY on n8npc before v1.0.1 ship (hard gate)** — source: n8n `execution.types.ts` `Retry` route | Public API v1 has NO retry endpoint; only /rest. Fixes the 404 bug (was wrongly `POST /api/v1/executions/{id}/retry`). |

> **Rule (from plan-review):** every new `/rest` (and licensed Public-API) endpoint a command depends on gets a row here — auth mode, body, shape guard, license, n8n version tested — BEFORE implementation. The `execution retry` bug (a fabricated Public-API endpoint that only passed against a mock) is exactly what this matrix prevents.

### Public-API governance endpoints (1.5.0 — per docs.n8n.io/api/api-reference; mock-tested, live-verify on a licensed instance before relying in prod)

| Endpoint | Method | Auth | Body | Response | License | Notes |
|---|---|---|---|---|---|---|
| `/api/v1/users` | POST | API key (owner) | ARRAY `[{email, role?}]`, role ∈ `global:admin\|global:member` | array of `{user:{id,email,inviteAcceptUrl?},error?}` per entry | user mgmt | invite; partial failures per entry |
| `/api/v1/users/{id}` | DELETE | API key (owner) | — | 204 | user mgmt | id or email |
| `/api/v1/users/{id}/role` | PATCH | API key (owner) | `{newRoleName: 'global:admin'\|'global:member'}` | 200 | user mgmt | |
| `/api/v1/projects` | POST | API key | `{name}` | `{id,name,type}` | **Projects (paid)** | rethrowWithLicenseHint |
| `/api/v1/projects/{id}` | PUT | API key | `{name}` | 204/200 | Projects | rename |
| `/api/v1/projects/{id}` | DELETE | API key | — | 204 | Projects | |
| `/api/v1/projects/{id}/users` | POST | API key | `{relations:[{userId, role}]}`, role ∈ `project:admin\|project:editor\|project:viewer` | 201 | Projects | add members |
| `/api/v1/projects/{id}/users/{userId}` | DELETE | API key | — | 204 | Projects | remove member |

### Public-API archive endpoints (1.7.0 workflow archive/unarchive — n8n-io/n8n PR #27513, merged 2026-03-27)

| Endpoint | Method | Auth | Body | Response | License | Notes |
|---|---|---|---|---|---|---|
| `/api/v1/workflows/{id}/archive` | POST | API key (`workflow:delete` scope) | — | `{...workflow, isArchived:true, active:false}` | none | **LIVE-VERIFIED absent on n8npc 1.122.5 → 404** (field `isArchived` exists in the model but the endpoint does not). Present in current n8n (checked ≤ 2.34.5). Archiving forces `active:false` (source: `WorkflowService.archive`); archiving an already-archived wf is a 200 no-op (`skipArchived:true`). |
| `/api/v1/workflows/{id}/unarchive` | POST | API key (`workflow:delete` scope) | — | `{...workflow, isArchived:false}` | none | Unarchiving a non-archived wf → **400** (`BadRequestError`, maps to exit 1). Does NOT re-activate — stays inactive. |

> **404-disambiguation contract**: a 404 on these paths is ambiguous (missing workflow vs missing endpoint on an old instance). `archiveWithVersionGuard` re-GETs the workflow on 404 — GET 404 ⇒ genuinely missing (rethrow original); GET 200 ⇒ endpoint absent ⇒ upgrade hint. Verified on n8npc 1.122.5 where the GET-200 branch fires.

---
<details><summary>Original template (superseded by findings above)</summary>

## Validated against
- n8n version (`versionCli`): `1.122.5` (from /rest/settings — re-confirm)
- Execution mode / topology: `[ ]` (single-main | queue | multi-web) — from POC #3
- Date verified: `[ ]`
- Verified by: `[ ]`

## 1. Login  (`POST /rest/login`)
- Canonical body key: `[ ]`  (`email` | `emailOrLdapLoginId` | both required)
- Success status: `[ ]`
- Auth cookie name: `[ ]` (expect `n8n-auth`)
- Cookie attrs: `[ ]` (HttpOnly / SameSite / Max-Age / Secure)
- Additional cookies set: `[ ]` (full jar — session client must replay all)
- Cookie expiry / TTL: `[ ]`  → drives 401 re-login cadence

## 2. CSRF
- Required on mutating `/rest`? `[ ]` (yes/no — a /save returning 403 ⇒ yes)
- Token source: `[ ]` (settings field | cookie | login response)
- Header name n8n expects: `[ ]` (e.g. `X-CSRF-TOKEN`)

## 3. Whoami  (`GET /rest/login`)
- Returns user object: `[ ]` (shape: `{ data: { id, email, role } }`?)
- 401 when cookie invalid/expired: `[ ]` (yes ⇒ used for re-login trigger)

## 4. Save / register  (`PATCH /rest/workflows/{id}`)
- **Exact request body** (from browser DevTools on a real UI "Save"): `[ ]`
  - Requires `versionId` (optimistic lock)? `[ ]` (missing ⇒ 400/409)
  - Full field list n8n expects: `[ ]`
  - Decision: `buildSaveBody` = **echo GET `/rest/workflows/{id}` near-verbatim** (NOT a 5-field subset, NOT `stripReadOnlyFields`).
- before/after field-drop diff: `[ ]` (no field dropped ✓ / list dropped)
- active state preserved: `[ ]`
- **Re-registers triggers (LOAD-BEARING):** `[ ]`
  - Sequence tested: create → API-activate → API-update → save  (same process)
  - Webhook: before-save `[ ]` (expect 404) → after-save `[ ]` (expect 2xx)
  - Cron: fires after save? `[ ]`

## 5. Run  (`POST /rest/workflows/{id}/run`)
- Request body that worked: `[ ]` (`{ workflowData }` | + runData/startNodes)
- Returns `data.executionId`: `[ ]`
- **executionId queryable via Public API** `GET /api/v1/executions/{id}`: `[ ]`
  - yes ⇒ `run --wait` reuses `waitForExecution(factory.client())`
  - no  ⇒ `run --wait` must poll `/rest/executions` (session) OR read sync body
- Chosen `--wait` path: `[ ]`
- Fallback endpoint if id-scoped 404: `POST /rest/workflows/run` tested? `[ ]`

## 6. Support matrix / fail-closed
- Supported n8n versions: `[ ]`
- Supported topology: single-main only? `[ ]`
- `doctor` session-probe must FAIL-CLOSED (block run/save) when live shape
  diverges from the values pinned above.

---
### Raw POC output
```
[ paste `node scripts/poc-session-mode.mjs --register <fixtureId> n8nctl-poc` output here ]
```
### Real UI Save body (DevTools)
```
[ paste the exact PATCH /rest/workflows/{id} request body the n8n UI sends ]
```
</details>
