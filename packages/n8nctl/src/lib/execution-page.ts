import type { N8nClient } from './api.js';
import type { ExecutionStatus } from '../types/n8n.js';
import { ApiError } from './errors.js';

/** Rows requested per page when the caller does not say. */
export const DEFAULT_PAGE_SIZE = 100;
/** Hard ceiling on the requested page size; never exceeded, never grown. */
export const MAX_PAGE_SIZE = 250;
/** Consecutive pages adding no new in-window row before the scan gives up. */
export const MAX_EMPTY_PAGES = 3;

export interface ExecutionWindowOptions {
  workflowId?: string;
  status?: ExecutionStatus;
  includeData?: boolean;
  /** Hard cap on the items returned (positive integer). */
  limit: number;
  /** Cutoff on startedAt, epoch ms; rows that started before it are skipped. */
  since?: number;
  /** Requested page size, clamped to [1, MAX_PAGE_SIZE]. */
  pageSize?: number;
}

export type WindowStopReason = 'end' | 'limit' | 'since';

export interface ExecutionWindow<R> {
  items: R[];
  pages: number;
  truncated: boolean;
  stopReason: WindowStopReason;
}

const SHAPE_MESSAGE = 'n8n API returned an unexpected /executions response shape';
const SHAPE_HINT =
  'The response does not match the n8n Public API format. Check that N8N_HOST points at an n8n instance whose API supports cursor pagination.';
const LOOP_HINT =
  'The n8n server is not advancing its pagination. Retry later; if it persists, narrow the query or check the n8n instance logs.';

/**
 * Fetch one window of executions from `GET /executions`, newest first,
 * following `nextCursor` until the window ends, and map every kept row through
 * `map` at once so only mapped values are held.
 *
 * `map` receives the raw row unvalidated, typed `unknown` because the API
 * shape is a claim, not a check. Only `id` and `startedAt` are read here, and a row with a null or
 * unparseable `startedAt` is kept, so the mapper must tolerate missing fields.
 * Anything the mapper throws becomes a protocol error naming the row index.
 *
 * Per row, in API order: a row whose id was already kept is skipped; with
 * `since`, a row whose startedAt parses to a time before `since` is skipped
 * (a null or unparseable startedAt is kept); otherwise `map(raw)` is kept.
 *
 * Stop rules, evaluated after each page in this order:
 *  1. `limit` reached on this page (mid-page or on its last row): the rest of
 *     the page is only classified, never kept. If an in-window row remains, or
 *     the page did not end the window (nextCursor non-null and the page is not
 *     all-older, rule 2), stop with 'limit', truncated true. Otherwise fall
 *     through to rules 2 and 3, judged on the whole page, with truncated false.
 *  2. Every row on the page with a parseable startedAt is older than `since`,
 *     and at least one such row exists: stop with 'since'. A page that merely
 *     contains some older rows does not stop the scan.
 *  3. nextCursor null or absent: stop with 'end'.
 *  4. Rules 2 and 3 both hold: 'since' (rule 2 is checked first).
 *  5. nextCursor already requested: throw ("repeated pagination cursor").
 *  6. MAX_EMPTY_PAGES consecutive pages adding no new in-window row while
 *     nextCursor stays non-null: throw ("no progress"). There is no page-count
 *     cap, so a server that clamps the page size lower is not a false positive.
 * Rules 1-4 run before 5 and 6, so a page that ends the window never fails on
 * a cursor that will not be followed.
 *
 * Ordering: the repo only proves the head of the list is newest. Rows further
 * down may be out of startedAt order, so the `since` cutoff is conservative:
 * it ends the window only on a page that is entirely older.
 *
 * Memory: one raw page (requested as at most MAX_PAGE_SIZE rows; a server
 * that ignores `limit` can return more, and client.get has parsed the whole
 * body before it is seen here) plus at most `limit` mapped items plus the
 * kept-id set (at most `limit` ids) and one cursor per page. The raw page is
 * dropped after it is scanned.
 *
 * Errors: transport failures are not wrapped. ApiError (401/403/404/5xx,
 * exit 1) and NetworkError (exit 4) propagate from client.get unchanged, with
 * their status and hint, after its GET retry on 429/502/503/504 and network
 * errors. This module raises only protocol violations (a malformed body,
 * cursor or row, a repeated cursor, no progress) as an ApiError with a
 * synthetic status 200, because client.get returns only the body (precedent:
 * session-api.ts runWorkflow). They always carry a hint, never the raw body
 * or row (an includeData page holds runData), and exit 1. They are thrown
 * outside the transport retry loop, so no http-error event is emitted for
 * them. Throwing instead of returning a partial window is deliberate: a report
 * that looks complete but stopped early is worse than a loud failure.
 *
 * @throws RangeError when `limit` is not a positive safe integer (a caller
 *   bug: flag values are validated before any fetch).
 */
export async function fetchExecutionWindow<R>(
  client: N8nClient,
  opts: ExecutionWindowOptions,
  map: (raw: unknown) => R,
): Promise<ExecutionWindow<R>> {
  const { limit } = opts;
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new RangeError(`fetchExecutionWindow: limit must be a positive integer, got ${limit}`);
  }
  // Typed as number, but Phase 3 holds parseSince's `number | null`.
  const since = typeof opts.since === 'number' && Number.isFinite(opts.since) ? opts.since : null;
  const baseParams = buildParams(opts);

  const items: R[] = [];
  const keptIds = new Set<string>();
  const requestedCursors = new Set<string>();
  let cursor: string | null = null;
  let pages = 0;
  let emptyPages = 0;

  for (;;) {
    const params = cursor === null ? baseParams : { ...baseParams, cursor };
    const page = readPage(await client.get<unknown>('/executions', params));
    pages++;

    const keptBefore = items.length;
    let limitHit = false;
    let inWindowLeft = false;
    let parseable = 0;
    let older = 0;

    for (let i = 0; i < page.data.length; i++) {
      const raw = page.data[i];
      const startedMs = startedAtMs(raw);
      const isOlder = since !== null && startedMs !== null && startedMs < since;
      if (startedMs !== null) parseable++;
      if (isOlder) older++;

      const id = rowId(raw);
      if ((id !== null && keptIds.has(id)) || isOlder) continue;
      if (limitHit) {
        inWindowLeft = true;
        continue;
      }
      items.push(mapRow(map, raw, i, pages));
      if (id !== null) keptIds.add(id);
      if (items.length === limit) limitHit = true;
    }

    const allOlder = parseable > 0 && older === parseable;
    if (limitHit && (inWindowLeft || (page.nextCursor !== null && !allOlder))) {
      return { items, pages, truncated: true, stopReason: 'limit' };
    }
    if (allOlder) return { items, pages, truncated: false, stopReason: 'since' };
    if (page.nextCursor === null) return { items, pages, truncated: false, stopReason: 'end' };

    if (requestedCursors.has(page.nextCursor)) {
      throw protocolError(
        `n8n API sent a repeated pagination cursor on page ${pages} of /executions; aborting to avoid an infinite loop`,
        LOOP_HINT,
      );
    }
    emptyPages = items.length === keptBefore ? emptyPages + 1 : 0;
    if (emptyPages >= MAX_EMPTY_PAGES) {
      throw protocolError(
        `n8n API made no progress on /executions: ${emptyPages} consecutive pages added no new execution; aborting`,
        LOOP_HINT,
      );
    }
    requestedCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
}

function buildParams(opts: ExecutionWindowOptions): Record<string, unknown> {
  const params: Record<string, unknown> = { limit: clampPageSize(opts.pageSize) };
  if (opts.workflowId !== undefined) params.workflowId = opts.workflowId;
  if (opts.status !== undefined) params.status = opts.status;
  if (opts.includeData === true) params.includeData = true;
  return params;
}

function clampPageSize(pageSize: number | undefined): number {
  if (pageSize === undefined || !Number.isFinite(pageSize)) return DEFAULT_PAGE_SIZE;
  return Math.min(Math.max(Math.trunc(pageSize), 1), MAX_PAGE_SIZE);
}

interface Page {
  data: unknown[];
  nextCursor: string | null;
}

function readPage(body: unknown): Page {
  if (!isRecord(body) || !Array.isArray(body.data)) throw protocolError(SHAPE_MESSAGE, SHAPE_HINT);
  const next = body.nextCursor;
  if (next === undefined || next === null) return { data: body.data, nextCursor: null };
  if (typeof next === 'string' && next.length > 0) return { data: body.data, nextCursor: next };
  throw protocolError(SHAPE_MESSAGE, SHAPE_HINT);
}

function mapRow<R>(map: (raw: unknown) => R, raw: unknown, index: number, page: number): R {
  try {
    return map(raw);
  } catch {
    // The mapper's own message may quote the row, so it is not forwarded.
    throw protocolError(`${SHAPE_MESSAGE}: row at index ${index} of page ${page} could not be read`, SHAPE_HINT);
  }
}

function rowId(raw: unknown): string | null {
  if (!isRecord(raw)) return null;
  const id = raw.id;
  return typeof id === 'string' || typeof id === 'number' ? String(id) : null;
}

function startedAtMs(raw: unknown): number | null {
  if (!isRecord(raw) || typeof raw.startedAt !== 'string') return null;
  const ms = Date.parse(raw.startedAt);
  return Number.isFinite(ms) ? ms : null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function protocolError(message: string, hint: string): ApiError {
  return new ApiError(message, 200, undefined, hint);
}
