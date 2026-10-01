import { Command } from 'commander';
import { withAction } from '../../lib/runtime.js';
import { printData } from '../../lib/output.js';
import { parsePositiveInt } from '../../lib/util.js';
import { ApiError, ValidationError } from '../../lib/errors.js';
import { fetchExecutionWindow, type WindowStopReason } from '../../lib/execution-page.js';
import {
  MAX_ERROR_CLUSTERS,
  computeExecutionStats,
  extractErrorSignature,
  parseDuration,
  parseSince,
  toBucket,
  toExecutionRecord,
  type ErrorSignature,
  type ExecutionRecord,
  type ExecutionStats,
  type GroupStats,
} from '../../lib/execution-stats.js';
import type { N8nClient } from '../../lib/api.js';
import type { Factory } from '../../factory.js';

interface StatsOpts {
  workflow?: string;
  since?: string;
  limit?: string;
  stuckAfter?: string;
}

export const DEFAULT_LIMIT = 1000;
export const MAX_LIMIT = 20000;
export const DEFAULT_STUCK_AFTER_MS = 3_600_000;
/** Pass 2 asks for full runData per row, so its pages stay small. */
export const DETAIL_PAGE_SIZE = 20;
/** Cap per active-scan status (running, waiting); hitting it sets stuckTruncated. */
export const STUCK_SCAN_LIMIT = 500;
/** Margin over the pass-1 failure count for rows that arrive between the passes. */
export const DETAIL_SLACK = 100;

/** The `window` object of the `--json` output: every key always present. */
interface StatsWindow {
  workflowId: string | null;
  since: string | null;
  limit: number;
  fetched: number;
  pages: number;
  truncated: boolean;
  stopReason: WindowStopReason;
  oldestStartedAt: string | null;
  newestStartedAt: string | null;
  generatedAt: string;
  detailPages: number;
  detailTruncated: boolean;
  stuckScope: 'active-scan';
  stuckScanned: number;
  stuckTruncated: boolean;
}

type StatsReport = { window: StatsWindow } & ExecutionStats;

/**
 * `execution stats`: a read-only report, never a gate. Exit 0 whenever the
 * report is produced (failures and stuck runs included); consumers gate with
 * --jq. Every fetch finishes before anything is printed, so an API failure on
 * any pass leaves stdout empty rather than printing a partial report.
 */
export async function executionStatsHandler(
  factory: Factory,
  opts: StatsOpts,
  _args: string[],
): Promise<void> {
  const nowMs = Date.now();
  const limit = parsePositiveInt(opts.limit, '--limit', DEFAULT_LIMIT);
  if (limit > MAX_LIMIT) {
    throw new ValidationError(`--limit must be at most ${MAX_LIMIT}, got "${opts.limit}"`);
  }
  const stuckAfterMs = parseDuration(opts.stuckAfter, '--stuck-after', DEFAULT_STUCK_AFTER_MS);
  const sinceMs = parseSince(opts.since, nowMs);

  const client = await factory.client();
  const workflowId = opts.workflow;

  // Pass 1 (summary): no includeData; rows are slimmed at once.
  const summary = await fetchExecutionWindow(
    client,
    { workflowId, limit, since: sinceMs ?? undefined },
    toExecutionRecord,
  );

  // Active scan: stuck runs are the oldest rows, exactly the ones --since and
  // --limit cut first, so they are scanned separately with no since cutoff.
  const [running, waiting] = await Promise.all([
    fetchExecutionWindow(client, { workflowId, status: 'running', limit: STUCK_SCAN_LIMIT }, toExecutionRecord),
    fetchExecutionWindow(client, { workflowId, status: 'waiting', limit: STUCK_SCAN_LIMIT }, toExecutionRecord),
  ]);

  const startedRange = startedAtRange(summary.items);
  const detail = await attachErrorSignatures(client, summary.items, {
    workflowId,
    limit,
    // No parseable pass-1 startedAt: fall back to the user's cutoff; pass 2 is
    // still bounded by limit, and ids outside pass 1 are ignored.
    since: startedRange?.oldestMs ?? sinceMs ?? undefined,
  });

  const stats = computeExecutionStats(summary.items, {
    nowMs,
    stuckAfterMs,
    activeRecords: [...running.items, ...waiting.items],
  });

  const window: StatsWindow = {
    workflowId: workflowId ?? null,
    since: sinceMs === null ? null : new Date(sinceMs).toISOString(),
    limit,
    fetched: summary.items.length,
    pages: summary.pages,
    truncated: summary.truncated,
    stopReason: summary.stopReason,
    oldestStartedAt: startedRange ? new Date(startedRange.oldestMs).toISOString() : null,
    newestStartedAt: startedRange ? new Date(startedRange.newestMs).toISOString() : null,
    generatedAt: new Date(nowMs).toISOString(),
    detailPages: detail.pages,
    detailTruncated: detail.truncated,
    stuckScope: 'active-scan',
    stuckScanned: running.items.length + waiting.items.length,
    stuckTruncated: running.truncated || waiting.truncated,
  };

  if (window.truncated) {
    warnTruncated(factory, 'window', limit, window.fetched);
  }
  if (window.stuckTruncated) {
    warnTruncated(factory, 'stuck', STUCK_SCAN_LIMIT, window.stuckScanned);
  }
  if (window.detailTruncated) {
    warnTruncated(factory, 'detail', limit, detail.fetched);
  }
  if (detail.crashedUnavailable) {
    factory.io.event(
      'execution-stats-detail-unavailable',
      { level: 'warn', status: 'crashed' },
      'warning: the API rejected status=crashed as a filter; crashed executions count as withoutDetail',
    );
  }

  const report: StatsReport = { window, ...stats };
  await printData(report, { io: factory.io, opts: factory.flags }, tableView);
}

/**
 * Pass 2 (error detail): only when pass 1 holds a failed record. Signatures
 * are attached in place to pass-1 failed records; a row whose id is not in
 * pass 1 (it arrived between the passes) is ignored, and a row whose data was
 * pruned yields no signature, so its record counts as withoutDetail.
 */
async function attachErrorSignatures(
  client: N8nClient,
  records: ExecutionRecord[],
  opts: { workflowId?: string; limit: number; since?: number },
): Promise<DetailResult> {
  const result: DetailResult = { pages: 0, truncated: false, fetched: 0, crashedUnavailable: false };
  const failedById = new Map<string, ExecutionRecord>();
  const failedPerStatus = new Map<'error' | 'crashed', number>();
  for (const r of records) {
    const bucket = toBucket(r.status);
    if (bucket !== 'error' && bucket !== 'crashed') continue;
    failedById.set(r.id, r);
    failedPerStatus.set(bucket, (failedPerStatus.get(bucket) ?? 0) + 1);
  }

  for (const [status, failed] of failedPerStatus) {
    let detail;
    try {
      detail = await fetchExecutionWindow(
        client,
        {
          workflowId: opts.workflowId,
          status,
          includeData: true,
          // Rows newer than pass 1 come first; past them, only pass-1 failures
          // can match, so the scan stops after that many plus a margin.
          limit: Math.min(opts.limit, failed + DETAIL_SLACK),
          since: opts.since,
          pageSize: DETAIL_PAGE_SIZE,
        },
        (e): { id: string; error: ErrorSignature | null } => {
          // toExecutionRecord throws first on a non-object row, so e has keys here.
          const { id } = toExecutionRecord(e);
          return { id, error: extractErrorSignature((e as { data?: unknown }).data) };
        },
      );
    } catch (err) {
      // Not every n8n version accepts status=crashed as a filter (unverified):
      // a 400 there degrades to "no detail for crashed", anything else fails loud.
      if (status === 'crashed' && err instanceof ApiError && err.status === 400) {
        result.crashedUnavailable = true;
        continue;
      }
      throw err;
    }
    for (const { id, error } of detail.items) {
      const record = failedById.get(id);
      if (record !== undefined && error !== null) record.error = error;
    }
    result.pages += detail.pages;
    result.truncated ||= detail.truncated;
    result.fetched += detail.items.length;
  }
  return result;
}

interface DetailResult {
  pages: number;
  truncated: boolean;
  fetched: number;
  crashedUnavailable: boolean;
}

function startedAtRange(
  records: ExecutionRecord[],
): { oldestMs: number; newestMs: number } | null {
  let oldestMs = Infinity;
  let newestMs = -Infinity;
  for (const r of records) {
    if (r.startedAt === null) continue;
    const ms = Date.parse(r.startedAt);
    if (!Number.isFinite(ms)) continue;
    if (ms < oldestMs) oldestMs = ms;
    if (ms > newestMs) newestMs = ms;
  }
  return Number.isFinite(oldestMs) ? { oldestMs, newestMs } : null;
}

// Through io.event, never a raw stderr write, so --log-format ndjson stays valid.
function warnTruncated(
  factory: Factory,
  scope: 'window' | 'stuck' | 'detail',
  limit: number,
  fetched: number,
): void {
  const texts = {
    window: `warning: window cut at --limit ${limit} (${fetched} executions scanned); raise --limit or narrow --since for the full window`,
    stuck: `warning: active scan hit its cap of ${limit} per status (${fetched} running/waiting scanned); the stuck list may be incomplete`,
    detail: `warning: error-detail pass cut at --limit ${limit} (${fetched} failed executions read with data); some failures count as withoutDetail`,
  };
  const text = texts[scope];
  factory.io.event('execution-stats-truncated', { level: 'warn', scope, limit, fetched }, text);
}

// No message or node column on purpose: no execution-data string reaches the table.
function tableView(d: unknown): { head: string[]; rows: string[][] } {
  const report = d as StatsReport;
  const row = (label: string, g: GroupStats): string[] => [
    label,
    String(g.count),
    String(g.byStatus.success),
    String(g.byStatus.error),
    `${g.byStatus.running}/${g.byStatus.waiting}`,
    g.failureRate === null ? '-' : `${(g.failureRate * 100).toFixed(1)}%`,
    formatMs(g.duration.p50Ms),
    formatMs(g.duration.p95Ms),
    String(g.stuck),
  ];
  return {
    head: ['WORKFLOW', 'TOTAL', 'SUCCESS', 'ERROR', 'RUN/WAIT', 'FAIL%', 'P50', 'P95', 'STUCK'],
    rows: [...report.workflows.map((w) => row(w.workflowId, w)), row('TOTAL', report.totals)],
  };
}

function formatMs(ms: number | null): string {
  return ms === null ? '-' : `${ms}ms`;
}

export function createStatsCommand(): Command {
  return new Command('stats')
    .description(
      `Aggregate executions: per-workflow status counts + failure rate and duration p50/p95 over a window, stuck running/waiting executions (scanned separately, not limited by the window, capped at ${STUCK_SCAN_LIMIT} per status newest first: when cut, stuck holds the newest and a warning says so), and the top ${MAX_ERROR_CLUSTERS} error clusters (node + normalized message). Read-only; error text is redacted.`,
    )
    .option('--workflow <id>', 'Filter to one workflow')
    .option(
      '--since <when>',
      'Window start: a duration ago (30m, 24h, 7d) or an ISO-8601 time with Z or an offset, or a YYYY-MM-DD date (UTC); client-side cutoff',
    )
    .option(
      '--limit <n>',
      'Max executions scanned for the window, newest first (default 1000, max 20000)',
    )
    .option(
      '--stuck-after <duration>',
      'Flag running/waiting executions older than this; a unit is required (e.g. 30m, 2h; default 1h)',
    )
    .action(withAction<StatsOpts>(executionStatsHandler));
}
