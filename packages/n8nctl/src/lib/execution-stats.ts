/**
 * Pure execution-health analytics for `n8nctl execution stats`.
 *
 * Turns slim execution records into a typed, deterministic ExecutionStats
 * object: per-workflow status counts, failure rate, duration percentiles,
 * stuck executions and error clusters. No I/O, no timers, and the clock is
 * never read here: `nowMs` is always a parameter, so the same input always
 * produces byte-identical JSON.
 *
 * Semantics (decided in plan 260930-execution-stats):
 * - Status bucket: the lower-cased `status`; missing or unrecognised goes to
 *   `unknown`. This deliberately differs from `execution list`
 *   (`finished ? 'finished' : 'running'`): a status-less row is not guessed as
 *   running, so it can never be reported as stuck.
 * - Failed = error + crashed. Terminal = success + error + canceled + crashed.
 *   failureRate = failed / terminal, or null when nothing terminated.
 * - Duration counts only terminal executions with parseable startedAt and
 *   stoppedAt and stop >= start (zero counts). Anything else is skipped as
 *   notFinished (non-terminal or null stoppedAt), clockSkew (stop < start) or
 *   unparseable.
 * - Stuck: running or waiting, parseable startedAt, and
 *   `nowMs - startedAt > stuckAfterMs` (strict), deduped by id. Computed from
 *   `activeRecords` (the unbounded active scan) when given, else from records.
 * - Every string taken from execution data (error message, sample, node label)
 *   goes through sanitizeText before it can reach output.
 * - Output order never depends on input order (see computeExecutionStats).
 *
 * Emitted timestamps (stuck[].startedAt, firstSeen, lastSeen) are normalised
 * to UTC ISO so two spellings of the same instant cannot reorder output;
 * waitTill is passed through raw because it may be unparseable.
 */

import { ValidationError } from './errors.js';
import { redactExecutionData } from './redact-execution.js';
import { scrubAnsi } from './util.js';

export const STATUS_BUCKETS = [
  'new',
  'running',
  'waiting',
  'success',
  'error',
  'canceled',
  'crashed',
  'unknown',
] as const;
export type StatusBucket = (typeof STATUS_BUCKETS)[number];

// Local on purpose: the terminal set in execution.ts is not exported.
export const TERMINAL_BUCKETS: ReadonlySet<StatusBucket> = new Set<StatusBucket>([
  'success',
  'error',
  'canceled',
  'crashed',
]);
export const FAILED_BUCKETS: ReadonlySet<StatusBucket> = new Set<StatusBucket>(['error', 'crashed']);

/** Group key for executions whose workflowId is null. */
export const UNKNOWN_WORKFLOW = '(unknown)';
export const MAX_CLUSTER_EXECUTION_IDS = 10;
export const MAX_NORMALIZED_LEN = 200;
export const MAX_SAMPLE_LEN = 300;
export const MAX_NODE_LABEL_LEN = 120;

/**
 * Cap on a stored signature message, applied AFTER sanitizing so a cut can
 * never leave a partial secret unmatched. Bounds memory when a window holds
 * thousands of failures whose message is a whole HTML error page; the
 * normalized message and the sample only ever read the head.
 */
const MAX_SIGNATURE_LEN = 2000;
const MIN_DURATION_MS = 1000;
/** ECMAScript Date range: +/- 8.64e15 ms around the epoch. */
const MAX_DATE_MS = 8.64e15;
const REDACTED = '[REDACTED]';

export interface ErrorSignature {
  /** Sanitized node label, or null when the error names no node. */
  node: string | null;
  /** Sanitized message. */
  message: string;
}

export interface ExecutionRecord {
  id: string;
  workflowId: string | null;
  status: string | null;
  startedAt: string | null;
  stoppedAt: string | null;
  waitTill: string | null;
  error: ErrorSignature | null;
}

export interface DurationStats {
  count: number;
  p50Ms: number | null;
  p95Ms: number | null;
  skipped: { notFinished: number; clockSkew: number; unparseable: number };
}

export interface GroupStats {
  count: number;
  byStatus: Record<StatusBucket, number>;
  failed: number;
  terminal: number;
  failureRate: number | null;
  duration: DurationStats;
  stuck: number;
}

export interface WorkflowStats extends GroupStats {
  workflowId: string;
}

export interface StuckExecution {
  id: string;
  workflowId: string;
  status: 'running' | 'waiting';
  startedAt: string;
  ageMs: number;
  waitTill: string | null;
  scheduledResume: boolean;
}

export interface ErrorCluster {
  node: string | null;
  message: string;
  count: number;
  workflowIds: string[];
  /** At most MAX_CLUSTER_EXECUTION_IDS, canonical member order. */
  executionIds: string[];
  /** Sanitized + masked, at most MAX_SAMPLE_LEN chars. */
  sample: string;
  firstSeen: string | null;
  lastSeen: string | null;
}

export interface ExecutionStats {
  stuckAfterMs: number;
  totals: GroupStats;
  workflows: WorkflowStats[];
  stuck: StuckExecution[];
  /** The MAX_ERROR_CLUSTERS largest clusters, in compareClusters order. */
  errorClusters: ErrorCluster[];
  /** Clusters past MAX_ERROR_CLUSTERS, dropped from errorClusters. */
  errorClustersOmitted: number;
  /** Executions in the omitted clusters, so cluster counts still add up to errorDetail.withDetail. */
  errorExecutionsOmitted: number;
  errorDetail: { errorExecutions: number; withDetail: number; withoutDetail: number };
}

/** All-distinct messages (HTML bodies) would otherwise make one cluster per failure. */
export const MAX_ERROR_CLUSTERS = 50;

// ---------------------------------------------------------------------------
// Records

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** An id-like value: a non-empty string or a finite number (as a string). */
function idOrNull(value: unknown): string | null {
  if (typeof value === 'string') return value === '' ? null : value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

/**
 * Slim a raw /executions row to an ExecutionRecord. `data` is never copied,
 * so a mapped window holds no runData. Throws TypeError (never echoing the
 * row, which may hold execution data) when the row is not an object or has
 * no string or number id.
 */
export function toExecutionRecord(e: unknown): ExecutionRecord {
  if (!isRecord(e)) throw new TypeError('execution row is not an object');
  const rawId = idOrNull(e.id);
  if (rawId === null) throw new TypeError('execution row has no string or number id');
  // An id made only of unsafe chars is shown escaped rather than dropped, so
  // one odd row neither aborts the scan nor merges with another row.
  const id = cleanOrNull(rawId) ?? escapeForDisplay(rawId);
  return {
    id,
    workflowId: cleanOrNull(idOrNull(e.workflowId)),
    status: cleanOrNull(stringOrNull(e.status)),
    startedAt: cleanOrNull(stringOrNull(e.startedAt)),
    stoppedAt: cleanOrNull(stringOrNull(e.stoppedAt)),
    waitTill: cleanOrNull(stringOrNull(e.waitTill)),
    error: null,
  };
}

/**
 * Server strings reach --json and --template unescaped: drop ANSI, control
 * characters (tabs and newlines too, which scrubAnsi keeps for free text) and
 * format characters. These fields are ids, statuses and timestamps, never prose.
 */
function cleanOrNull(value: string | null): string | null {
  if (value === null) return null;
  const clean = stripUnsafeChars(value).replace(/[\t\r\n]/g, '');
  return clean === '' ? null : clean;
}

/** Every char outside printable ASCII as a \uXXXX escape: visible, unique, inert. */
function escapeForDisplay(value: string): string {
  return value.replace(/[^\x21-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

// ---------------------------------------------------------------------------
// Sanitization

/**
 * Raw input is cut to this length BEFORE any regex runs, so the cost of
 * sanitizing is bounded whatever an execution echoes into its error. The
 * surviving head is sanitized in full (see capRawText for the cut itself).
 * The outputs read at most MAX_SIGNATURE_LEN chars, far below this.
 */
const MAX_RAW_TEXT_LEN = 64 * 1024;
/**
 * A cut at MAX_RAW_TEXT_LEN can split a token below its pattern's minimum
 * length, so the visible prefix escapes redaction. A cut input is therefore
 * backed off to the last delimiter within this many chars, or by all of them.
 */
const TRUNCATION_BACKOFF = 256;
const TOKEN_DELIMITER_RE = /[\s,;&"'()<>[\]{}]/;

function capRawText(s: string): string {
  if (s.length <= MAX_RAW_TEXT_LEN) return s;
  const head = s.slice(0, MAX_RAW_TEXT_LEN);
  for (let i = head.length - 1; i >= head.length - TRUNCATION_BACKOFF; i--) {
    if (TOKEN_DELIMITER_RE.test(head[i])) return head.slice(0, i);
  }
  return head.slice(0, head.length - TRUNCATION_BACKOFF);
}

/**
 * Unicode format characters (zero-width, bidi overrides and isolates) and the
 * line/paragraph separators survive scrubAnsi: they can split a key name so a
 * pattern misses it, and they spoof terminal output. The rest are invisible
 * fillers outside Cf (combining grapheme joiner, Hangul and Khmer fillers,
 * Mongolian and standard variation selectors); visible combining marks such
 * as Vietnamese diacritics are kept. Stripped locally so the shared scrubAnsi
 * keeps its behaviour.
 */
const FORMAT_CHARS_RE =
  /[\p{Cf}\u2028\u2029\u034F\u115F\u1160\u17B4\u17B5\u180B-\u180D\u180F\u3164\uFE00-\uFE0F\uFFA0\u{E0100}-\u{E01EF}]/gu;

function stripUnsafeChars(s: string): string {
  return scrubAnsi(s).replace(FORMAT_CHARS_RE, '');
}

/*
 * ReDoS rule for every pattern below: a pattern may only start on a literal
 * or a bounded prefix. An unbounded class before a literal that can fail
 * (e.g. `[a-z0-9.-]*://`) rescans the rest of the run from every boundary,
 * which is quadratic on long dotted or dashed text.
 */

/** Base64 credential after `Basic`; the class check below spares plain words. */
const BASIC_AUTH_RE = /\bBasic\s+([A-Za-z0-9+/]{6,}={0,2})/gi;
/** Optional quote around a key or value, also in JSON-escaped form (\"). */
const Q = String.raw`\\?["']?`;
const LOCAL_SECRET_PATTERNS: Array<[RegExp, string]> = [
  // URL userinfo: scheme://user:pass@ or scheme://token@ (scheme length bounded)
  // (greedy to the LAST @ before the path, so a password holding @ is covered;
  // quotes, commas and angle brackets end it, so a host-only URL in compact
  // JSON does not swallow a later email: a password holding those chars is
  // the accepted miss)
  [/\b([a-z][a-z0-9+.-]{0,31}:\/\/)[^\s/?#"',;<>]+@/gi, `$1${REDACTED}@`],
  // Schemeless user:password@host (connection strings without a scheme)
  [/(?<![\w.+-])[\w.+-]{1,64}:[^\s@/:"',;<>]{1,128}@(?=[A-Za-z0-9-]+\.[A-Za-z0-9.-]+)/g, `${REDACTED}@`],
  // curl -u user:password / --user=user:password (the separator and the user
  // part share no char, so a run of = cannot backtrack quadratically)
  [/((?:^|\s)(?:-u|--user)(?:\s+|=))[^\s:=]+:\S+/g, `$1${REDACTED}`],
  // Google OAuth access tokens and Stripe test keys (the shared list has live keys)
  [/\bya29\.[A-Za-z0-9_-]{20,}/g, REDACTED],
  [/\b[rs]k_test_[A-Za-z0-9]{16,}/g, REDACTED],
  // Secret query parameters
  [
    /([?&](?:api[_-]?key|apikey|key|auth|token|access[_-]?token|secret|password|sig|signature|x-amz-signature|x-amz-credential|x-amz-security-token)=)[^&#\s]*/gi,
    `$1${REDACTED}`,
  ],
  // PEM or PGP private key, with real newlines or the literal \n of a JSON string
  [
    /-----BEGIN [A-Z ]{0,40}PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z ]{0,40}PRIVATE KEY(?: BLOCK)?-----|$)/g,
    REDACTED,
  ],
  // redactExecutionData only knows the capitalised form
  [/\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, REDACTED],
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, REDACTED],
  // Slack bot/user/app/refresh tokens (xoxb-, xoxp-, xoxe.xoxp-, xapp-, ...)
  [/\b(?:xox[abeprs](?:\.xox[a-z])?|xapp)-[A-Za-z0-9-]{8,}/g, REDACTED],
  // GitHub token families redactExecutionData does not list (it has ghp_)
  [/\bgh[ousr]_[A-Za-z0-9]{20,}/g, REDACTED],
  [/\bglpat-[A-Za-z0-9_-]{20,}/g, REDACTED],
  // SendGrid SG.<id>.<secret>
  [/\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g, REDACTED],
  // Telegram bot token <bot id>:<35-char secret>
  // (no \b: in /bot123:... the id is glued to "bot")
  [/(?<!\d)\d{6,12}:[A-Za-z0-9_-]{30,}/g, REDACTED],
  // Webhook URLs whose path is the credential
  [/(hooks\.slack\.com\/services\/)[A-Za-z0-9/_-]+/gi, `$1${REDACTED}`],
  [/(discord(?:app)?\.com\/api\/webhooks\/)[A-Za-z0-9/_-]+/gi, `$1${REDACTED}`],
  // Authorization and Cookie headers carry several parameters (Digest
  // response=, AWS4 Signature=, cookie pairs): redact to the end of the line.
  [
    new RegExp(String.raw`(?<![A-Za-z0-9-])((?:proxy-)?authorization${Q}\s*[:=]\s*${Q})(?!\[REDACTED\])[^\r\n]+`, 'gi'),
    `$1${REDACTED}`,
  ],
  [
    new RegExp(String.raw`(?<![A-Za-z0-9-])((?:set-)?cookie${Q}\s*[:=]\s*${Q})[^\r\n"'\\]+`, 'gi'),
    `$1${REDACTED}`,
  ],
];

/**
 * Secret keys are detected by NAME, so camelCase and compound keys
 * (accessToken, clientSecret, session_id, passwordHash, x-amz-signature) need
 * no list of their own. Over-matching (author:, primaryKey:) is the accepted
 * direction.
 */
const SECRET_KEY_NAME = 'pass|pwd|secret|token|key|auth|session|cred|signature';
/**
 * key: value / key=value where the key token itself carries a secret name.
 * The name test lives INSIDE the regex on purpose: matching every key and
 * filtering afterwards lets a plain key (`Error:`, `https:`) consume a value
 * that holds a secret pair, which replace() then never rescans. The key is a
 * whole token of at most 30 + name + 30 chars, so each start is bounded.
 * Values, in order:
 * - JSON-escaped string \"...\": one level of inner escapes (\\\\, \\\") understood;
 * - plain JSON string "...", escape-aware;
 * - a quote that opened but did not parse: redacted to the next , } ] or end of line;
 * - single-quoted '...';
 * - unquoted: ends at whitespace, so a multi-word passphrase keeps its tail
 *   (accepted: redacting to end of line would erase ordinary messages such as
 *   "password: must be 8 chars").
 */
const KEY_VALUE_RE = new RegExp(
  String.raw`(?<![A-Za-z0-9_-])([A-Za-z0-9_-]{0,30}(?:${SECRET_KEY_NAME})[A-Za-z0-9_-]{0,30})` +
    String.raw`(${Q}\s*(?:=>|->|[:=])\s*)(?!\\?["']?\[REDACTED\])` +
    String.raw`(\\"(?:\\\\(?:\\\\|\\"|[^\\"])|[^\\"]|\\[^\\"])*\\"|"(?:[^"\\]|\\[\s\S])*"|\\?"[^,}\]\r\n]*|'[^']*'|[^\s,;&'"\\]+)`,
  'gi',
);

/**
 * Free-text secrets with no key=value shape and no known prefix, such as
 * "Incorrect API key provided: <opaque>": a secret word, up to three short
 * words, a separator, an optional quote, then a value whose first 16 chars are
 * token-like. The whole value is consumed to the next space or delimiter, so a
 * secret holding ! $ @ : cannot leave its tail behind. The length floor keeps
 * ordinary phrases ("token expired", "password must be 8 chars") readable; a
 * long plain word after a secret word is the accepted over-redaction.
 * Every whitespace run is bounded and the two separator forms do not chain
 * quantifiers, so a long run of spaces after a secret word stays linear.
 */
const TOKEN_AHEAD = String.raw`(?=[A-Za-z0-9._~+/=-]{16})`;
const SECRET_PHRASE_RE = new RegExp(
  String.raw`\b((?:api[ _-]?key|access[ _-]?key|secret[ _-]?key|token|secret|password|passphrase|credentials?|auth(?:entication|orization)?)\b` +
    String.raw`(?:[ \t]{1,4}[A-Za-z']{1,20}){0,3}?(?:[ \t]{0,4}[:=][ \t]{0,4}|[ \t]{1,4}))` +
    // A quoted value runs to its closing quote (or the end of the line when
    // unterminated), so a multi-word passphrase cannot keep its tail.
    String.raw`(?:"${TOKEN_AHEAD}(?:[^"\\\r\n]|\\.)*"?|'${TOKEN_AHEAD}[^'\r\n]*'?|\x60${TOKEN_AHEAD}[^\x60\r\n]*\x60?` +
    String.raw`|${TOKEN_AHEAD}[^\s,;&'"\x60\\]+)`,
  'gi',
);

/**
 * Make a string from execution data safe to print: cap the raw length, then
 * scrub ANSI and control characters FIRST (redacting first would let an ANSI
 * sequence split a token so the pattern misses it, and the later scrub would
 * rejoin it), then the shared execution-data redaction, then local free-text
 * secret patterns. Only recognisable secret shapes can be caught;
 * over-redaction is the accepted failure direction.
 */
export function sanitizeText(s: string): string {
  let out = redactExecutionData(stripUnsafeChars(capRawText(s)));
  out = out.replace(BASIC_AUTH_RE, (match, token: string) =>
    // Real base64 of user:pass nearly always holds an inner upper-case letter,
    // a digit or +/=; "Basic authentication" does not.
    /[A-Z0-9+/=]/.test(token.slice(1)) ? `Basic ${REDACTED}` : match,
  );
  for (const [re, replacement] of LOCAL_SECRET_PATTERNS) {
    out = out.replace(re, replacement);
  }
  out = out.replace(SECRET_PHRASE_RE, `$1${REDACTED}`);
  return out.replace(KEY_VALUE_RE, `$1$2${REDACTED}`);
}

function nodeLabel(raw: string): string {
  return sanitizeText(raw).slice(0, MAX_NODE_LABEL_LEN);
}

// ---------------------------------------------------------------------------
// Normalization

/** Double quotes, backticks, and single quotes not glued to a word ("doesn't"). */
const QUOTED_RE = /"[^"]*"|`[^`]*`|(?<![A-Za-z0-9])'[^']*'(?![A-Za-z0-9])/g;
const ISO_TS_RE =
  /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/gi;
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const TOKEN_RE = /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{8,}(?![A-Za-z0-9_-])/g;
const NUMBER_RE = /\d+(?:\.\d+)?/g;
const TS_UUID_OR_TOKEN_RE = new RegExp(
  `(${ISO_TS_RE.source})|(${UUID_RE.source})|${TOKEN_RE.source}`,
  'gi',
);

/**
 * Mask UUIDs and mixed letter+digit tokens of 8+ chars as `<id>`. Timestamps
 * are matched only to be left alone: the sample keeps them readable, and the
 * token rule would otherwise read `2026-09-30T10` as an id.
 */
function maskIds(s: string): string {
  return s.replace(TS_UUID_OR_TOKEN_RE, (match: string, ts?: string, uuid?: string) => {
    if (ts !== undefined) return match;
    if (uuid !== undefined) return '<id>';
    return /[A-Za-z]/.test(match) && /\d/.test(match) ? '<id>' : match;
  });
}

/**
 * Cluster key for an error message. Order matters: timestamps before ids
 * (else a timestamp becomes id fragments) and ids before bare numbers (else
 * `abc12345678` loses its digits and is never seen as an id).
 */
export function normalizeErrorMessage(msg: string): string {
  const masked = maskIds(sanitizeText(msg).replace(QUOTED_RE, '<str>').replace(ISO_TS_RE, '<ts>'))
    .replace(NUMBER_RE, '<n>')
    .replace(/\s+/g, ' ')
    .trim();
  return masked === '' ? '(empty message)' : masked.slice(0, MAX_NORMALIZED_LEN);
}

/** Human-readable cluster sample: sanitized, quoted values and ids masked, numbers kept. */
export function sampleMessage(msg: string): string {
  return maskIds(sanitizeText(msg).replace(QUOTED_RE, '<str>')).slice(0, MAX_SAMPLE_LEN);
}

// ---------------------------------------------------------------------------
// Error signatures

function firstText(...values: unknown[]): string | null {
  for (const v of values) {
    if (typeof v === 'string' && v !== '') return v;
  }
  return null;
}

function makeSignature(node: string | null, message: string): ErrorSignature {
  return {
    node: node === null ? null : nodeLabel(node),
    message: sanitizeText(message).slice(0, MAX_SIGNATURE_LEN),
  };
}

/** Message of the most recent erroring run of one node, or null. */
function lastRunError(runs: unknown): string | null {
  if (!Array.isArray(runs)) return null;
  for (let i = runs.length - 1; i >= 0; i--) {
    const run: unknown = runs[i];
    if (isRecord(run) && isRecord(run.error)) {
      return firstText(run.error.message, run.error.name) ?? 'error';
    }
  }
  return null;
}

/**
 * Locate the error of one execution's `data`, following the repo convention:
 * `resultData.error` first (node.name; message, then description, then name),
 * otherwise `resultData.runData`, preferring `lastNodeExecuted`, then the
 * first erroring node in key order (error.message, then error.name, then
 * 'error'). Node label and message come back sanitized. Any malformed shape
 * returns null; it never throws.
 */
export function extractErrorSignature(data: unknown): ErrorSignature | null {
  if (!isRecord(data) || !isRecord(data.resultData)) return null;
  const resultData = data.resultData;
  if (isRecord(resultData.error)) {
    const err = resultData.error;
    const node = isRecord(err.node) && typeof err.node.name === 'string' ? err.node.name : null;
    return makeSignature(node, firstText(err.message, err.description, err.name) ?? 'error');
  }
  const runData = resultData.runData;
  if (!isRecord(runData)) return null;
  const last = resultData.lastNodeExecuted;
  if (typeof last === 'string' && Object.hasOwn(runData, last)) {
    const message = lastRunError(runData[last]);
    if (message !== null) return makeSignature(last, message);
  }
  for (const [node, runs] of Object.entries(runData)) {
    const message = lastRunError(runs);
    if (message !== null) return makeSignature(node, message);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Percentiles and flag parsing

/**
 * Nearest-rank percentile of an ascending numeric array:
 * `rank = clamp(ceil((p * n) / 100), 1, n)`, value = `sortedAsc[rank - 1]`.
 * `p * n` is computed before the division so integer inputs stay exact.
 * n = 0 returns null; n = 1 returns the single value for every p.
 */
export function percentileNearestRank(sortedAsc: number[], p: number): number | null {
  const n = sortedAsc.length;
  if (n === 0) return null;
  const rank = Math.min(n, Math.max(1, Math.ceil((p * n) / 100)));
  return sortedAsc[rank - 1];
}

const DURATION_RE = /^(\d+)(ms|s|m|h|d)$/;
const UNIT_MS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
const DURATION_HINT = 'add a unit: 30m, 2h, 1d or 90000ms';

/**
 * Parse a duration flag: digits plus a required unit (ms, s, m, h, d).
 * A bare integer is rejected (is `30` seconds or minutes?). The result must
 * be a safe integer of at least 1000 ms. Returns `defMs` when absent.
 */
export function parseDuration(value: string | undefined, flagName: string, defMs: number): number {
  if (value === undefined) return defMs;
  if (/^\d+$/.test(value)) {
    throw new ValidationError(`${flagName} needs a unit, got "${value}"`, DURATION_HINT);
  }
  const m = DURATION_RE.exec(value);
  if (m === null) {
    throw new ValidationError(
      `${flagName} must be a duration such as 30m, 2h or 1d, got "${value}"`,
      DURATION_HINT,
    );
  }
  const ms = Number(m[1]) * UNIT_MS[m[2]];
  if (!Number.isSafeInteger(ms) || ms < MIN_DURATION_MS) {
    throw new ValidationError(
      `${flagName} must be between 1s and ${Number.MAX_SAFE_INTEGER}ms, got "${value}"`,
    );
  }
  return ms;
}

const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(?:Z|[+-](\d{2}):(\d{2}))$/;
const SINCE_HINT =
  'use a duration (24h, 7d) or an ISO-8601 time with an offset (2026-09-30T10:00:00Z) or a date (2026-09-30)';

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** Component check, because Date.parse accepts 2026-02-30 and T24:00. */
function isValidDateParts(parts: string[]): boolean {
  const [year, month, day, hour = '0', minute = '0', second = '0', offH = '0', offM = '0'] = parts;
  const y = Number(year);
  const mo = Number(month);
  const d = Number(day);
  return (
    mo >= 1 &&
    mo <= 12 &&
    d >= 1 &&
    d <= daysInMonth(y, mo) &&
    Number(hour) <= 23 &&
    Number(minute) <= 59 &&
    Number(second) <= 59 &&
    Number(offH) <= 23 &&
    Number(offM) <= 59
  );
}

/**
 * Resolve `--since` to epoch ms (null when absent). Accepts a duration
 * (parseDuration rules, meaning nowMs minus it), a date-only `YYYY-MM-DD`
 * (UTC midnight), or a date-time with an explicit `Z` or `+hh:mm`/`-hh:mm`
 * offset. An offset-less date-time is rejected rather than read in the
 * machine's local zone. Invalid calendar dates, results outside the Date
 * range and future times throw ValidationError.
 */
export function parseSince(value: string | undefined, nowMs: number): number | null {
  if (value === undefined) return null;
  if (/^\d+[A-Za-z]*$/.test(value)) {
    const ms = nowMs - parseDuration(value, '--since', 0);
    if (ms < -MAX_DATE_MS) {
      throw new ValidationError(`--since reaches before the earliest supported date, got "${value}"`);
    }
    return ms;
  }
  const m = DATE_ONLY_RE.exec(value) ?? DATE_TIME_RE.exec(value);
  const ms = m === null ? Number.NaN : Date.parse(value);
  if (m === null || !isValidDateParts(m.slice(1)) || Number.isNaN(ms)) {
    throw new ValidationError(`--since is not a valid duration or ISO-8601 time, got "${value}"`, SINCE_HINT);
  }
  if (ms > nowMs) {
    throw new ValidationError(`--since is in the future, got "${value}"`);
  }
  return ms;
}

// ---------------------------------------------------------------------------
// Aggregation

interface GroupAcc {
  count: number;
  byStatus: Record<StatusBucket, number>;
  durations: number[];
  skipped: DurationStats['skipped'];
  stuck: number;
}

interface ClusterMember {
  id: string;
  startMs: number;
  workflowId: string;
}

interface ClusterAcc {
  node: string | null;
  message: string;
  members: ClusterMember[];
  /** Only the canonical-first member keeps its message: the sample source. */
  first: ClusterMember;
  firstMessage: string;
}

type DurationOutcome = number | 'notFinished' | 'clockSkew' | 'unparseable';

const BUCKET_SET: ReadonlySet<string> = new Set(STATUS_BUCKETS);

export function toBucket(status: string | null): StatusBucket {
  const lower = status?.toLowerCase();
  return lower !== undefined && BUCKET_SET.has(lower) ? (lower as StatusBucket) : 'unknown';
}

function parseTs(value: string | null): number {
  return value === null ? Number.NaN : Date.parse(value);
}

function newAcc(): GroupAcc {
  const byStatus = {} as Record<StatusBucket, number>;
  for (const b of STATUS_BUCKETS) byStatus[b] = 0;
  return {
    count: 0,
    byStatus,
    durations: [],
    skipped: { notFinished: 0, clockSkew: 0, unparseable: 0 },
    stuck: 0,
  };
}

function durationOf(r: ExecutionRecord, bucket: StatusBucket): DurationOutcome {
  if (!TERMINAL_BUCKETS.has(bucket) || r.stoppedAt === null) return 'notFinished';
  const start = parseTs(r.startedAt);
  const stop = parseTs(r.stoppedAt);
  if (Number.isNaN(start) || Number.isNaN(stop)) return 'unparseable';
  return stop < start ? 'clockSkew' : stop - start;
}

function addToAcc(acc: GroupAcc, bucket: StatusBucket, duration: DurationOutcome): void {
  acc.count++;
  acc.byStatus[bucket]++;
  if (typeof duration === 'number') acc.durations.push(duration);
  else acc.skipped[duration]++;
}

function finalize(acc: GroupAcc): GroupStats {
  let failed = 0;
  let terminal = 0;
  for (const b of STATUS_BUCKETS) {
    if (FAILED_BUCKETS.has(b)) failed += acc.byStatus[b];
    if (TERMINAL_BUCKETS.has(b)) terminal += acc.byStatus[b];
  }
  const sorted = [...acc.durations].sort((a, b) => a - b);
  return {
    count: acc.count,
    byStatus: acc.byStatus,
    failed,
    terminal,
    failureRate: terminal === 0 ? null : failed / terminal,
    duration: {
      count: sorted.length,
      p50Ms: percentileNearestRank(sorted, 50),
      p95Ms: percentileNearestRank(sorted, 95),
      skipped: acc.skipped,
    },
    stuck: acc.stuck,
  };
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

const NUMERIC_ID_RE = /^\d+$/;

/**
 * Total order on ids. n8n ids are numeric strings, compared numerically (by
 * length, then lexically, so no precision loss); non-numeric ids sort after
 * all numeric ones, lexically. Mixing the two rules pairwise without the
 * numeric-first split would not be transitive (9 < 10 < 1a < 9).
 */
function compareIds(a: string, b: string): number {
  const aNum = NUMERIC_ID_RE.test(a);
  const bNum = NUMERIC_ID_RE.test(b);
  if (aNum !== bNum) return aNum ? -1 : 1;
  if (aNum && a.length !== b.length) return a.length - b.length;
  return compareStrings(a, b);
}

/** Canonical member order: startedAt desc (unparseable last), then id desc. */
function compareMembers(a: ClusterMember, b: ClusterMember): number {
  const aBad = Number.isNaN(a.startMs);
  const bBad = Number.isNaN(b.startMs);
  if (aBad !== bBad) return aBad ? 1 : -1;
  if (!aBad && a.startMs !== b.startMs) return b.startMs - a.startMs;
  return compareIds(b.id, a.id);
}

function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

function finalizeCluster(c: ClusterAcc): ErrorCluster {
  const members = [...c.members].sort(compareMembers);
  // A loop, not Math.min(...spread): a cluster can hold up to `limit` members.
  let first = Number.NaN;
  let last = Number.NaN;
  for (const { startMs } of members) {
    if (Number.isNaN(startMs)) continue;
    if (Number.isNaN(first) || startMs < first) first = startMs;
    if (Number.isNaN(last) || startMs > last) last = startMs;
  }
  return {
    node: c.node,
    message: c.message,
    count: members.length,
    workflowIds: [...new Set(members.map((m) => m.workflowId))].sort(compareStrings),
    executionIds: members.slice(0, MAX_CLUSTER_EXECUTION_IDS).map((m) => m.id),
    sample: sampleMessage(c.firstMessage),
    firstSeen: Number.isNaN(first) ? null : toIso(first),
    lastSeen: Number.isNaN(last) ? null : toIso(last),
  };
}

function compareClusters(a: ErrorCluster, b: ErrorCluster): number {
  if (a.count !== b.count) return b.count - a.count;
  if (a.node !== b.node) {
    if (a.node === null) return 1;
    if (b.node === null) return -1;
    return compareStrings(a.node, b.node);
  }
  return compareStrings(a.message, b.message);
}

function stuckEntry(r: ExecutionRecord, nowMs: number, stuckAfterMs: number): StuckExecution | null {
  const bucket = toBucket(r.status);
  if (bucket !== 'running' && bucket !== 'waiting') return null;
  const startMs = parseTs(r.startedAt);
  if (Number.isNaN(startMs)) return null;
  const ageMs = nowMs - startMs;
  if (!(ageMs > stuckAfterMs)) return null;
  const waitTillMs = parseTs(r.waitTill);
  return {
    id: r.id,
    workflowId: r.workflowId ?? UNKNOWN_WORKFLOW,
    status: bucket,
    startedAt: toIso(startMs),
    ageMs,
    waitTill: r.waitTill,
    scheduledResume: bucket === 'waiting' && !Number.isNaN(waitTillMs) && waitTillMs > nowMs,
  };
}

/**
 * Aggregate one window of records into ExecutionStats in a single pass over
 * `records` (so a one-shot iterator is fine), then one pass over
 * `activeRecords` when given.
 *
 * Output is independent of input order: workflows by failed desc, count desc,
 * workflowId asc; stuck by ageMs desc, id asc; errorClusters by count desc,
 * node asc (null last), message asc. A cluster's executionIds are its members
 * in canonical order (startedAt desc, unparseable last, then id desc) capped
 * at MAX_CLUSTER_EXECUTION_IDS, and its sample comes from the first of them.
 * Only failed records carrying an ErrorSignature are clustered; the rest count
 * as errorDetail.withoutDetail. A stuck row whose workflow has no window
 * record still gets a workflow row with zero window counts. When two active
 * rows share an id, the first one seen wins.
 */
export function computeExecutionStats(
  records: Iterable<ExecutionRecord>,
  opts: { nowMs: number; stuckAfterMs: number; activeRecords?: Iterable<ExecutionRecord> },
): ExecutionStats {
  const { nowMs, stuckAfterMs, activeRecords } = opts;
  const totals = newAcc();
  const byWorkflow = new Map<string, GroupAcc>();
  const clusters = new Map<string, ClusterAcc>();
  const stuckById = new Map<string, StuckExecution>();
  const errorDetail = { errorExecutions: 0, withDetail: 0, withoutDetail: 0 };

  const workflowAcc = (id: string): GroupAcc => {
    let acc = byWorkflow.get(id);
    if (acc === undefined) {
      acc = newAcc();
      byWorkflow.set(id, acc);
    }
    return acc;
  };
  const considerStuck = (r: ExecutionRecord): void => {
    if (stuckById.has(r.id)) return;
    const entry = stuckEntry(r, nowMs, stuckAfterMs);
    if (entry !== null) stuckById.set(r.id, entry);
  };

  for (const r of records) {
    const bucket = toBucket(r.status);
    const workflowId = r.workflowId ?? UNKNOWN_WORKFLOW;
    const duration = durationOf(r, bucket);
    addToAcc(totals, bucket, duration);
    addToAcc(workflowAcc(workflowId), bucket, duration);
    if (activeRecords === undefined) considerStuck(r);
    if (!FAILED_BUCKETS.has(bucket)) continue;

    errorDetail.errorExecutions++;
    if (r.error === null) {
      errorDetail.withoutDetail++;
      continue;
    }
    errorDetail.withDetail++;
    // Re-sanitize the label here too: callers may hand in raw signatures.
    const node = r.error.node === null ? null : nodeLabel(r.error.node);
    const message = normalizeErrorMessage(r.error.message);
    const key = JSON.stringify([node, message]);
    const member: ClusterMember = { id: r.id, startMs: parseTs(r.startedAt), workflowId };
    const cluster = clusters.get(key);
    if (cluster === undefined) {
      clusters.set(key, { node, message, members: [member], first: member, firstMessage: r.error.message });
      continue;
    }
    cluster.members.push(member);
    if (compareMembers(member, cluster.first) < 0) {
      cluster.first = member;
      cluster.firstMessage = r.error.message;
    }
  }
  if (activeRecords !== undefined) {
    for (const r of activeRecords) considerStuck(r);
  }

  const stuck = [...stuckById.values()].sort(
    (a, b) => b.ageMs - a.ageMs || compareIds(a.id, b.id),
  );
  for (const s of stuck) {
    totals.stuck++;
    workflowAcc(s.workflowId).stuck++;
  }

  const workflows: WorkflowStats[] = [...byWorkflow.entries()]
    .map(([workflowId, acc]) => ({ workflowId, ...finalize(acc) }))
    .sort(
      (a, b) =>
        b.failed - a.failed || b.count - a.count || compareStrings(a.workflowId, b.workflowId),
    );

  const errorClusters = [...clusters.values()].map(finalizeCluster).sort(compareClusters);
  return {
    stuckAfterMs,
    totals: finalize(totals),
    workflows,
    stuck,
    errorClusters: errorClusters.slice(0, MAX_ERROR_CLUSTERS),
    errorClustersOmitted: Math.max(0, errorClusters.length - MAX_ERROR_CLUSTERS),
    errorExecutionsOmitted: errorClusters.slice(MAX_ERROR_CLUSTERS).reduce((sum, c) => sum + c.count, 0),
    errorDetail,
  };
}
