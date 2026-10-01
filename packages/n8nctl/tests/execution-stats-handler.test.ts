import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { makeFakeFactory, type FakeFactory } from './helpers/fake-factory.js';
import {
  executionStatsHandler,
  STUCK_SCAN_LIMIT,
  DETAIL_SLACK,
  DETAIL_PAGE_SIZE,
  DETAIL_STATUSES,
} from '../src/commands/execution/stats.js';
import { createExecutionCommand } from '../src/commands/execution/index.js';
import { completionHandler } from '../src/commands/completion.js';
import { buildProgram } from '../src/program.js';
import { FAILED_BUCKETS, STATUS_BUCKETS } from '../src/lib/execution-stats.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** ISO timestamp `msAgo` before now; fixtures use wide margins against 1h thresholds. */
const ago = (msAgo: number): string => new Date(Date.now() - msAgo).toISOString();

interface Row {
  id: string;
  workflowId?: string | null;
  status?: string;
  startedAt?: string | null;
  stoppedAt?: string | null;
  waitTill?: string | null;
  data?: unknown;
}

/** A terminal row that started `msAgo` before now and ran for `durationMs`. */
const finished = (
  id: string,
  workflowId: string,
  status: string,
  msAgo: number,
  durationMs: number,
): Row => {
  const start = Date.now() - msAgo;
  return {
    id,
    workflowId,
    status,
    startedAt: new Date(start).toISOString(),
    stoppedAt: new Date(start + durationMs).toISOString(),
  };
};

const errorData = (message: string, node?: string): unknown => ({
  resultData: { error: { message, ...(node === undefined ? {} : { node: { name: node } }) } },
});

type Route = 'summary' | 'running' | 'waiting' | 'detail' | 'crashed';
type Reply = Row[] | ((params: Record<string, unknown>) => [number, unknown]);

/**
 * Route GET /executions on its params: the active scans carry status running
 * or waiting, pass 2 carries status error with includeData, pass 1 has no
 * status. Returns the params of every call, grouped by route.
 */
function routeExecutions(
  env: FakeFactory,
  replies: Partial<Record<Route, Reply>>,
): Record<Route, Record<string, unknown>[]> {
  const calls: Record<Route, Record<string, unknown>[]> = {
    summary: [],
    running: [],
    waiting: [],
    detail: [],
    crashed: [],
  };
  env.apiMock.onGet('/executions').reply((cfg) => {
    const params = (cfg.params ?? {}) as Record<string, unknown>;
    let route: Route;
    if (params.status === 'running') route = 'running';
    else if (params.status === 'waiting') route = 'waiting';
    else if (params.status === 'error' && params.includeData === true) route = 'detail';
    else if (params.status === 'crashed' && params.includeData === true) route = 'crashed';
    else if (params.status === undefined && params.includeData === undefined) route = 'summary';
    else return [400, { message: `unexpected params ${JSON.stringify(params)}` }];
    calls[route].push(params);
    const reply = replies[route] ?? [];
    return typeof reply === 'function' ? reply(params) : [200, { data: reply, nextCursor: null }];
  });
  return calls;
}

const WINDOW_KEYS = [
  'workflowId',
  'since',
  'limit',
  'fetched',
  'pages',
  'truncated',
  'stopReason',
  'oldestStartedAt',
  'newestStartedAt',
  'generatedAt',
  'detailPages',
  'detailTruncated',
  'stuckScope',
  'stuckScanned',
  'stuckTruncated',
];

let savedExit: number | string | undefined;

beforeEach(() => {
  savedExit = process.exitCode;
  process.exitCode = undefined;
});

afterEach(() => {
  process.exitCode = savedExit;
});

describe('execution stats registration', () => {
  it('should register stats under execution with its four options when the noun is built', () => {
    const stats = createExecutionCommand().commands.find((c) => c.name() === 'stats');

    expect(stats).toBeDefined();
    expect(stats!.options.map((o) => o.long)).toEqual([
      '--workflow',
      '--since',
      '--limit',
      '--stuck-after',
    ]);
  });

  it('should list stats among the execution verbs when bash completion is generated', async () => {
    const env = makeFakeFactory();

    await completionHandler(env.factory, {}, ['bash'], buildProgram);

    // The verb list sits on the line right after the `execution)` case label.
    expect(env.stdout()).toMatch(/\bexecution\)\r?\n[^\n]*\bstats\b/);
  });
});

describe('execution stats handler', () => {
  it('should aggregate counts, rates, percentiles, stuck and clusters when two workflows mix statuses', async () => {
    const env = makeFakeFactory({ json: true });
    const summary: Row[] = [
      finished('c1', 'w1', 'crashed', 50 * MINUTE, 200),
      finished('e1', 'w1', 'error', 90 * MINUTE, 500),
      finished('s1', 'w1', 'success', 2 * HOUR, 1000),
      finished('s2', 'w1', 'success', 3 * HOUR, 3000),
      finished('e2', 'w2', 'error', 100 * MINUTE, 400),
      { id: 'r1', workflowId: 'w2', status: 'running', startedAt: ago(2 * HOUR), stoppedAt: null },
      finished('s3', 'w2', 'success', 4 * HOUR, 2000),
    ];
    const calls = routeExecutions(env, {
      summary,
      running: [
        { id: 'r1', workflowId: 'w2', status: 'running', startedAt: ago(2 * HOUR) },
        { id: 'r2', workflowId: 'w2', status: 'running', startedAt: ago(10 * MINUTE) },
      ],
      waiting: [
        {
          id: 'wt1',
          workflowId: 'w1',
          status: 'waiting',
          startedAt: ago(3 * HOUR),
          waitTill: ago(-DAY),
        },
      ],
      // c1 (crashed) gets its detail from the separate status=crashed pass.
      detail: [
        { ...summary[1], data: errorData('Request failed with status code 500 for id abc12345xyz', 'HTTP') },
        { ...summary[4], data: errorData('Request failed with status code 404 for id zz98765qq', 'HTTP') },
      ],
      crashed: [{ ...summary[0], data: errorData('Workflow did crash') }],
    });

    await executionStatsHandler(env.factory, {}, []);
    const out = JSON.parse(env.stdout());

    expect(out.totals).toMatchObject({ count: 7, failed: 3, terminal: 6, failureRate: 0.5, stuck: 2 });
    expect(out.totals.byStatus).toMatchObject({ success: 3, error: 2, crashed: 1, running: 1 });
    expect(out.workflows.map((w: { workflowId: string }) => w.workflowId)).toEqual(['w1', 'w2']);
    const [w1, w2] = out.workflows;
    expect(w1).toMatchObject({ count: 4, failed: 2, terminal: 4, failureRate: 0.5, stuck: 1 });
    expect(w1.duration).toMatchObject({ count: 4, p50Ms: 500, p95Ms: 3000 });
    expect(w2).toMatchObject({ count: 3, failed: 1, terminal: 2, failureRate: 0.5, stuck: 1 });
    expect(w2.duration).toMatchObject({ count: 2, p50Ms: 400, p95Ms: 2000 });
    expect(w2.duration.skipped.notFinished).toBe(1);

    expect(out.stuck.map((s: { id: string }) => s.id)).toEqual(['wt1', 'r1']);
    expect(out.stuck[0]).toMatchObject({ status: 'waiting', scheduledResume: true });
    expect(out.stuck[1]).toMatchObject({ status: 'running', workflowId: 'w2', scheduledResume: false });

    expect(out.errorDetail).toEqual({ errorExecutions: 3, withDetail: 3, withoutDetail: 0 });
    expect(out.errorClusters).toHaveLength(2);
    expect(out.errorClusters[0]).toMatchObject({
      node: 'HTTP',
      count: 2,
      workflowIds: ['w1', 'w2'],
      executionIds: ['e1', 'e2'],
    });
    expect(out.errorClusters[1]).toMatchObject({ node: null, count: 1, executionIds: ['c1'] });

    expect(out.window).toMatchObject({
      workflowId: null,
      since: null,
      limit: 1000,
      fetched: 7,
      pages: 1,
      truncated: false,
      stopReason: 'end',
      detailPages: 2,
      detailTruncated: false,
      stuckScope: 'active-scan',
      stuckScanned: 3,
      stuckTruncated: false,
    });
    expect(out.window.oldestStartedAt).toBe(summary[6].startedAt);
    expect(out.window.newestStartedAt).toBe(summary[0].startedAt);
    expect(calls.detail[0]).toMatchObject({ limit: 20, status: 'error', includeData: true });
    // Report, not gate: failures and stuck runs present, exit code untouched.
    expect(process.exitCode).toBeUndefined();
  });

  it('should keep stuck rows outside --since and beyond --limit when the active scan returns them', async () => {
    const env = makeFakeFactory({ json: true });
    routeExecutions(env, {
      summary: [
        finished('s1', 'w1', 'success', 10 * MINUTE, 100),
        finished('s2', 'w1', 'success', 20 * MINUTE, 100),
        { id: 'old', workflowId: 'w1', status: 'running', startedAt: ago(3 * DAY) },
      ],
      running: [
        { id: 'old', workflowId: 'w1', status: 'running', startedAt: ago(3 * DAY) },
        { id: 'r9', workflowId: 'w9', status: 'running', startedAt: ago(5 * HOUR) },
      ],
    });

    await executionStatsHandler(env.factory, { since: '24h', limit: '1' }, []);
    const out = JSON.parse(env.stdout());

    expect(out.window).toMatchObject({ fetched: 1, truncated: true, stopReason: 'limit' });
    expect(out.stuck.map((s: { id: string }) => s.id)).toEqual(['old', 'r9']);
    expect(out.window.stuckScope).toBe('active-scan');
    expect(out.window.stuckTruncated).toBe(false);
    // r9's workflow has no window rows but still gets a row.
    expect(out.workflows.find((w: { workflowId: string }) => w.workflowId === 'w9')).toMatchObject({
      count: 0,
      stuck: 1,
    });
  });

  it('should set stuckTruncated and warn with scope stuck when an active scan hits its cap', async () => {
    const env = makeFakeFactory({ json: true });
    const many: Row[] = Array.from({ length: STUCK_SCAN_LIMIT }, (_, i) => ({
      id: `r${i}`,
      workflowId: 'w1',
      status: 'running',
      startedAt: ago(2 * HOUR + i * 1000),
    }));
    routeExecutions(env, {
      running: (params) =>
        params.cursor === undefined ? [200, { data: many, nextCursor: 'more' }] : [500, {}],
    });

    await executionStatsHandler(env.factory, {}, []);
    const out = JSON.parse(env.stdout());

    expect(out.window.stuckTruncated).toBe(true);
    expect(out.window.stuckScanned).toBe(STUCK_SCAN_LIMIT);
    expect(out.stuck).toHaveLength(STUCK_SCAN_LIMIT);
    expect(env.events).toContainEqual(
      expect.objectContaining({
        event: 'execution-stats-truncated',
        payload: { level: 'warn', scope: 'stuck', limit: STUCK_SCAN_LIMIT, fetched: STUCK_SCAN_LIMIT },
      }),
    );
  });

  it('should emit exactly the stable JSON keys with nulls when the window is empty', async () => {
    const env = makeFakeFactory({ json: true });
    const calls = routeExecutions(env, {});

    await executionStatsHandler(env.factory, {}, []);
    const out = JSON.parse(env.stdout());

    expect(Object.keys(out)).toEqual([
      'window',
      'stuckAfterMs',
      'totals',
      'workflows',
      'stuck',
      'errorClusters',
      'errorClustersOmitted',
      'errorDetail',
    ]);
    expect(Object.keys(out.window)).toEqual(WINDOW_KEYS);
    expect(Object.keys(out.totals.byStatus)).toEqual([...STATUS_BUCKETS]);
    expect(Object.values(out.totals.byStatus)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(out.totals).toMatchObject({ count: 0, failureRate: null });
    expect(out.totals.duration).toMatchObject({ p50Ms: null, p95Ms: null });
    expect(out.window).toMatchObject({
      fetched: 0,
      oldestStartedAt: null,
      newestStartedAt: null,
      detailPages: 0,
      detailTruncated: false,
      stuckScanned: 0,
    });
    expect(out.window.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(out).toMatchObject({ workflows: [], stuck: [], errorClusters: [] });
    expect(out.errorDetail).toEqual({ errorExecutions: 0, withDetail: 0, withoutDetail: 0 });
    expect(calls.detail).toHaveLength(0);
    expect(env.apiMock.history.get).toHaveLength(3);
    expect(process.exitCode).toBeUndefined();
  });

  it('should skip pass 2 and report failureRate 0 when every execution succeeded', async () => {
    const env = makeFakeFactory({ json: true });
    const calls = routeExecutions(env, {
      summary: [finished('s1', 'w1', 'success', HOUR, 100), finished('s2', 'w1', 'success', HOUR, 300)],
    });

    await executionStatsHandler(env.factory, {}, []);
    const out = JSON.parse(env.stdout());

    expect(calls.detail).toHaveLength(0);
    expect(out.totals.failureRate).toBe(0);
    expect(out.totals.duration).toMatchObject({ count: 2, p50Ms: 100, p95Ms: 300 });
  });

  it('should count a running row without stoppedAt as notFinished when percentiles are computed', async () => {
    const env = makeFakeFactory({ json: true });
    routeExecutions(env, {
      summary: [
        { id: 'r1', workflowId: 'w1', status: 'running', startedAt: ago(5 * MINUTE) },
        finished('s1', 'w1', 'success', HOUR, 250),
      ],
    });

    await executionStatsHandler(env.factory, {}, []);
    const out = JSON.parse(env.stdout());

    expect(out.totals.byStatus.running).toBe(1);
    expect(out.totals.duration).toMatchObject({ count: 1, p50Ms: 250, p95Ms: 250 });
    expect(out.totals.duration.skipped.notFinished).toBe(1);
  });

  it('should forward --workflow as workflowId on pass 1, pass 2 and both active scans', async () => {
    const env = makeFakeFactory({ json: true });
    const calls = routeExecutions(env, { summary: [finished('e1', 'w1', 'error', HOUR, 10)] });

    await executionStatsHandler(env.factory, { workflow: 'w1' }, []);

    for (const route of ['summary', 'running', 'waiting', 'detail'] as const) {
      expect(calls[route]).toHaveLength(1);
      expect(calls[route][0].workflowId).toBe('w1');
    }
    expect(JSON.parse(env.stdout()).window.workflowId).toBe('w1');
  });

  it('should exclude rows older than --since 1h and report since as UTC ISO', async () => {
    const env = makeFakeFactory({ json: true });
    routeExecutions(env, {
      summary: [finished('new', 'w1', 'success', 30 * MINUTE, 10), finished('old', 'w1', 'success', 2 * HOUR, 10)],
    });

    const before = Date.now();
    await executionStatsHandler(env.factory, { since: '1h' }, []);
    const out = JSON.parse(env.stdout());

    expect(out.window.fetched).toBe(1);
    expect(out.window.since).toMatch(/Z$/);
    const sinceMs = Date.parse(out.window.since);
    expect(Math.abs(sinceMs - (before - HOUR))).toBeLessThan(MINUTE);
  });

  it.each(['yesterday', '2026-09-30T10:00', '24'])(
    'should reject --since %s with ValidationError before any API call',
    async (since) => {
      const env = makeFakeFactory({ json: true });
      routeExecutions(env, {});

      await expect(executionStatsHandler(env.factory, { since }, [])).rejects.toMatchObject({
        name: 'ValidationError',
        exitCode: 3,
      });
      expect(env.apiMock.history.get).toHaveLength(0);
    },
  );

  it.each(['abc', '0', '20001'])(
    'should reject --limit %s with ValidationError before any API call',
    async (limit) => {
      const env = makeFakeFactory({ json: true });
      routeExecutions(env, {});

      await expect(executionStatsHandler(env.factory, { limit }, [])).rejects.toMatchObject({
        name: 'ValidationError',
        exitCode: 3,
      });
      expect(env.apiMock.history.get).toHaveLength(0);
    },
  );

  it('should mark the window truncated and warn with scope window when --limit is hit mid-page', async () => {
    const env = makeFakeFactory({ json: true, logFormat: 'ndjson' });
    routeExecutions(env, {
      summary: [
        finished('a', 'w1', 'success', 10 * MINUTE, 1),
        finished('b', 'w1', 'success', 20 * MINUTE, 1),
        finished('c', 'w1', 'success', 30 * MINUTE, 1),
      ],
    });

    await executionStatsHandler(env.factory, { limit: '2' }, []);
    const out = JSON.parse(env.stdout());

    expect(out.window).toMatchObject({ limit: 2, fetched: 2, truncated: true, stopReason: 'limit' });
    expect(env.events).toContainEqual(
      expect.objectContaining({
        event: 'execution-stats-truncated',
        payload: { level: 'warn', scope: 'window', limit: 2, fetched: 2 },
      }),
    );
    const lines = env.stderr().trim().split('\n');
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
  });

  it.each([
    [undefined, 3_600_000],
    ['30m', 1_800_000],
  ])('should resolve --stuck-after %s to %i ms', async (stuckAfter, expected) => {
    const env = makeFakeFactory({ json: true });
    routeExecutions(env, {});

    await executionStatsHandler(env.factory, { stuckAfter }, []);

    expect(JSON.parse(env.stdout()).stuckAfterMs).toBe(expected);
  });

  it.each(['soon', '0s', '30', '-1h'])(
    'should reject --stuck-after %s with ValidationError before any API call',
    async (stuckAfter) => {
      const env = makeFakeFactory({ json: true });
      routeExecutions(env, {});

      await expect(executionStatsHandler(env.factory, { stuckAfter }, [])).rejects.toMatchObject({
        name: 'ValidationError',
        exitCode: 3,
      });
      expect(env.apiMock.history.get).toHaveLength(0);
    },
  );

  describe('redaction end to end', () => {
    const SECRETS = ['abcdef1234567890XYZ', 's3cretpw', 'hunter2', 'zzTOKENvalue987654'];
    const leakyRows = (): Partial<Record<Route, Reply>> => {
      const e1 = finished('e1', 'w1', 'error', HOUR, 10);
      return {
        summary: [e1],
        detail: [
          {
            ...e1,
            data: errorData(
              'Auth failed: Bearer abcdef1234567890XYZ calling https://admin:s3cretpw@api.example.com/v1 with password: hunter2',
              'HTTP \u001b[31mBearer zzTOKENvalue987654\u001b[0m',
            ),
          },
        ],
      };
    };

    it('should redact the cluster message, sample and node when --json output is printed', async () => {
      const env = makeFakeFactory({ json: true });
      routeExecutions(env, leakyRows());

      await executionStatsHandler(env.factory, {}, []);
      const stdout = env.stdout();
      const [cluster] = JSON.parse(stdout).errorClusters;

      expect(cluster.message).toContain('[REDACTED]');
      expect(cluster.sample).toContain('[REDACTED]');
      expect(cluster.node).toContain('[REDACTED]');
      for (const secret of SECRETS) expect(stdout).not.toContain(secret);
      expect(stdout).not.toContain('\u001b');
      expect(stdout).not.toContain('\\u001b');
    });

    it('should keep secrets out of --template output', async () => {
      const env = makeFakeFactory({
        template: '{{#each errorClusters}}{{node}}|{{message}}|{{sample}}{{/each}}',
      });
      routeExecutions(env, leakyRows());

      await executionStatsHandler(env.factory, {}, []);
      const stdout = env.stdout();

      expect(stdout).toContain('[REDACTED]');
      for (const secret of SECRETS) expect(stdout).not.toContain(secret);
      expect(stdout).not.toContain('\u001b');
    });
  });

  it('should ignore a pass-2 error row whose id is not in pass 1', async () => {
    const env = makeFakeFactory({ json: true });
    const e1 = finished('e1', 'w1', 'error', HOUR, 10);
    routeExecutions(env, {
      summary: [e1],
      detail: [
        { ...finished('late', 'w1', 'error', MINUTE, 10), data: errorData('arrived between passes', 'Late') },
        { ...e1, data: errorData('real failure', 'HTTP') },
      ],
    });

    await executionStatsHandler(env.factory, {}, []);
    const out = JSON.parse(env.stdout());

    expect(out.errorClusters).toHaveLength(1);
    expect(out.errorClusters[0]).toMatchObject({ node: 'HTTP', executionIds: ['e1'] });
    expect(out.totals.count).toBe(1);
  });

  it('should attach error detail to a pass-1 record whose status is upper case', async () => {
    const env = makeFakeFactory({ json: true });
    const e1 = finished('e1', 'w1', 'ERROR', HOUR, 10);
    routeExecutions(env, { summary: [e1], detail: [{ ...e1, data: errorData('boom', 'HTTP') }] });

    await executionStatsHandler(env.factory, {}, []);
    const out = JSON.parse(env.stdout());

    expect(out.errorClusters).toHaveLength(1);
    expect(out.errorClusters[0]).toMatchObject({ node: 'HTTP', executionIds: ['e1'] });
  });

  it('should attach detail to a crashed execution through a status=crashed pass', async () => {
    const env = makeFakeFactory({ json: true });
    const c1 = finished('c1', 'w1', 'crashed', HOUR, 10);
    const calls = routeExecutions(env, { summary: [c1], crashed: [{ ...c1, data: errorData('worker died', 'Code') }] });

    await executionStatsHandler(env.factory, {}, []);
    const out = JSON.parse(env.stdout());

    expect(calls.detail).toHaveLength(0);
    expect(calls.crashed).toHaveLength(1);
    expect(out.errorClusters[0]).toMatchObject({ node: 'Code', executionIds: ['c1'] });
    expect(out.errorDetail).toEqual({ errorExecutions: 1, withDetail: 1, withoutDetail: 0 });
  });

  it('should warn and count crashed as withoutDetail when the API rejects status=crashed', async () => {
    const env = makeFakeFactory({ json: true, logFormat: 'ndjson' });
    const c1 = finished('c1', 'w1', 'crashed', HOUR, 10);
    routeExecutions(env, { summary: [c1], crashed: () => [400, { message: 'bad status' }] });

    await executionStatsHandler(env.factory, {}, []);
    const out = JSON.parse(env.stdout());

    expect(out.errorDetail).toEqual({ errorExecutions: 1, withDetail: 0, withoutDetail: 1 });
    expect(env.events).toContainEqual(
      expect.objectContaining({
        event: 'execution-stats-detail-unavailable',
        payload: { level: 'warn', status: 'crashed' },
      }),
    );
  });

  it('should fetch detail for exactly the failed buckets', () => {
    expect([...DETAIL_STATUSES].sort()).toEqual([...FAILED_BUCKETS].sort());
  });

  it('should run the error pass before the crashed pass whatever order pass 1 lists them in', async () => {
    const env = makeFakeFactory({ json: true });
    routeExecutions(env, {
      summary: [finished('c1', 'w1', 'crashed', HOUR, 10), finished('e1', 'w1', 'error', 2 * HOUR, 10)],
    });

    await executionStatsHandler(env.factory, {}, []);

    const detailStatuses = env.apiMock.history.get
      .map((r) => (r.params ?? {}) as Record<string, unknown>)
      .filter((p) => p.includeData === true)
      .map((p) => p.status);
    expect(detailStatuses).toEqual(['error', 'crashed']);
  });

  it('should report only the cut pass in the warning when both passes run', async () => {
    const env = makeFakeFactory({ json: true });
    let page = 0;
    routeExecutions(env, {
      summary: [finished('e1', 'w1', 'error', HOUR, 10), finished('c1', 'w1', 'crashed', HOUR, 10)],
      detail: () => {
        page++;
        const data = Array.from({ length: 20 }, (_, i) => finished(`n${page}-${i}`, 'w1', 'error', MINUTE, 10));
        return [200, { data, nextCursor: `c${page}` }];
      },
      crashed: [],
    });

    await executionStatsHandler(env.factory, {}, []);

    const warning = env.events.find((e) => e.event === 'execution-stats-truncated');
    expect(warning?.payload).toMatchObject({ scope: 'detail', bound: 1 + DETAIL_SLACK, fetched: 1 + DETAIL_SLACK });
  });

  it('should warn once per cut pass, each with its own bound, when both passes are cut', async () => {
    const env = makeFakeFactory({ json: true });
    const endless = (prefix: string, status: string) => {
      let page = 0;
      return (): [number, unknown] => {
        page++;
        const data = Array.from({ length: 20 }, (_, i) => finished(`${prefix}${page}-${i}`, 'w1', status, MINUTE, 10));
        return [200, { data, nextCursor: `${prefix}${page}` }];
      };
    };
    routeExecutions(env, {
      summary: [finished('e1', 'w1', 'error', HOUR, 10), finished('c1', 'w1', 'crashed', HOUR, 10)],
      detail: endless('n', 'error'),
      crashed: endless('k', 'crashed'),
    });

    await executionStatsHandler(env.factory, { limit: '150' }, []);

    const warnings = env.events.filter((e) => e.event === 'execution-stats-truncated').map((e) => e.payload);
    expect(warnings).toEqual([
      { level: 'warn', scope: 'detail', limit: 150, fetched: 101, status: 'error', bound: 101 },
      { level: 'warn', scope: 'detail', limit: 150, fetched: 101, status: 'crashed', bound: 101 },
    ]);
  });

  it('should keep error detail when the crashed pass is rejected in the same run', async () => {
    const env = makeFakeFactory({ json: true, logFormat: 'ndjson' });
    const e1 = finished('e1', 'w1', 'error', HOUR, 10);
    const c1 = finished('c1', 'w1', 'crashed', 2 * HOUR, 10);
    const calls = routeExecutions(env, {
      summary: [e1, c1],
      detail: [{ ...e1, data: errorData('boom', 'HTTP') }],
      crashed: () => [400, { message: 'bad status' }],
    });

    await executionStatsHandler(env.factory, {}, []);
    const out = JSON.parse(env.stdout());

    expect(calls.detail).toHaveLength(1);
    expect(out.errorDetail).toEqual({ errorExecutions: 2, withDetail: 1, withoutDetail: 1 });
    expect(out.errorClusters[0]).toMatchObject({ node: 'HTTP', executionIds: ['e1'] });
    expect(env.events.map((e) => e.event)).toContain('execution-stats-detail-unavailable');
  });

  it('should fail loud when the crashed pass fails with anything but 400', async () => {
    const env = makeFakeFactory({ json: true });
    routeExecutions(env, {
      summary: [finished('c1', 'w1', 'crashed', HOUR, 10)],
      crashed: () => [500, { message: 'boom' }],
    });

    await expect(executionStatsHandler(env.factory, {}, [])).rejects.toMatchObject({ name: 'ApiError', status: 500 });
    expect(env.stdout()).toBe('');
  });

  it('should bound pass 2 by the pass-1 failure count plus a margin', async () => {
    const env = makeFakeFactory({ json: true });
    let page = 0;
    const calls = routeExecutions(env, {
      summary: [finished('e1', 'w1', 'error', HOUR, 10)],
      // Endless newer error rows: without the bound pass 2 would page to --limit.
      detail: () => {
        page++;
        const data = Array.from({ length: 20 }, (_, i) => finished(`n${page}-${i}`, 'w1', 'error', MINUTE, 10));
        return [200, { data, nextCursor: `c${page}` }];
      },
    });

    await executionStatsHandler(env.factory, {}, []);
    const out = JSON.parse(env.stdout());

    expect(calls.detail).toHaveLength(Math.ceil((1 + DETAIL_SLACK) / DETAIL_PAGE_SIZE));
    expect(out.window.detailTruncated).toBe(true);
    // The warning names the bound that cut the pass, not --limit.
    const warning = env.events.find((e) => e.event === 'execution-stats-truncated');
    expect(warning?.payload).toMatchObject({ scope: 'detail', limit: 1000, bound: 1 + DETAIL_SLACK });
    expect(warning?.text).toContain(`bound of ${1 + DETAIL_SLACK} rows`);
  });

  it('should warn with scope detail when pass 2 is cut at --limit', async () => {
    const env = makeFakeFactory({ json: true, logFormat: 'ndjson' });
    const e1 = finished('e1', 'w1', 'error', HOUR, 10);
    routeExecutions(env, {
      summary: [e1],
      detail: [
        { ...finished('late', 'w1', 'error', MINUTE, 10), data: errorData('arrived between passes', 'Late') },
        { ...e1, data: errorData('real failure', 'HTTP') },
      ],
    });

    await executionStatsHandler(env.factory, { limit: '1' }, []);
    const out = JSON.parse(env.stdout());

    expect(out.window).toMatchObject({ detailTruncated: true });
    expect(env.events).toContainEqual(
      expect.objectContaining({
        event: 'execution-stats-truncated',
        payload: { level: 'warn', scope: 'detail', limit: 1, fetched: 1, status: 'error', bound: 1 },
      }),
    );
  });

  it('should stop pass 2 at the oldest pass-1 startedAt when older error pages follow', async () => {
    const env = makeFakeFactory({ json: true });
    const e1 = finished('e1', 'w1', 'error', HOUR, 10);
    routeExecutions(env, {
      summary: [e1, finished('s1', 'w1', 'success', 2 * HOUR, 10)],
      // `since` is a client-side cutoff, so it is proven by where pass 2 stops:
      // page 2 is entirely older than s1 and ends the scan; page 3 would fail.
      detail: (params) => {
        if (params.cursor === undefined) {
          return [200, {
            data: [
              { ...e1, data: errorData('kept', 'HTTP') },
              { ...finished('o1', 'w1', 'error', 5 * HOUR, 10), data: errorData('older', 'Old') },
            ],
            nextCursor: 'p2',
          }];
        }
        if (params.cursor === 'p2') {
          return [200, {
            data: [{ ...finished('o2', 'w1', 'error', 6 * HOUR, 10), data: errorData('older', 'Old') }],
            nextCursor: 'p3',
          }];
        }
        return [500, { message: 'pass 2 scanned past the window' }];
      },
    });

    await executionStatsHandler(env.factory, {}, []);
    const out = JSON.parse(env.stdout());

    expect(out.window).toMatchObject({ detailPages: 2, detailTruncated: false });
    expect(out.errorClusters).toHaveLength(1);
    expect(out.errorClusters[0]).toMatchObject({ node: 'HTTP', executionIds: ['e1'] });
  });

  it('should count an error row with pruned data as withoutDetail and not cluster it', async () => {
    const env = makeFakeFactory({ json: true });
    const e1 = finished('e1', 'w1', 'error', HOUR, 10);
    routeExecutions(env, { summary: [e1], detail: [e1] });

    await executionStatsHandler(env.factory, {}, []);
    const out = JSON.parse(env.stdout());

    expect(out.errorDetail).toEqual({ errorExecutions: 1, withDetail: 0, withoutDetail: 1 });
    expect(out.errorClusters).toEqual([]);
  });

  it.each([401, 404, 500])('should reject with ApiError exit 1 when pass 1 returns %i', async (status) => {
    const env = makeFakeFactory({ json: true });
    routeExecutions(env, { summary: () => [status, { message: 'nope' }] });

    await expect(executionStatsHandler(env.factory, {}, [])).rejects.toMatchObject({
      name: 'ApiError',
      status,
      exitCode: 1,
    });
    expect(env.stdout()).toBe('');
  });

  it.each(['detail', 'running', 'waiting'] as const)(
    'should print nothing when the %s fetch fails with 500',
    async (route) => {
      const env = makeFakeFactory({ json: true });
      routeExecutions(env, {
        summary: [finished('e1', 'w1', 'error', HOUR, 10)],
        [route]: () => [500, { message: 'boom' }],
      });

      await expect(executionStatsHandler(env.factory, {}, [])).rejects.toMatchObject({
        name: 'ApiError',
        status: 500,
      });
      expect(env.stdout()).toBe('');
    },
  );

  it('should print the rendered template when --template is given', async () => {
    const env = makeFakeFactory({ template: '{{totals.count}}' });
    routeExecutions(env, {
      summary: [finished('s1', 'w1', 'success', HOUR, 10), finished('s2', 'w2', 'success', HOUR, 10)],
    });

    await executionStatsHandler(env.factory, {}, []);

    expect(env.stdout()).toBe('2\n');
  });

  it('should render a table with a TOTAL row when stdout is a TTY and no output flag is set', async () => {
    const env = makeFakeFactory();
    (env.factory.io as { isTTY: boolean }).isTTY = true;
    routeExecutions(env, {
      summary: [finished('s1', 'w1', 'success', HOUR, 10), finished('e1', 'w1', 'error', HOUR, 10)],
      detail: [{ ...finished('e1', 'w1', 'error', HOUR, 10), data: errorData('secret-free', 'HTTP') }],
    });

    await executionStatsHandler(env.factory, {}, []);
    const stdout = env.stdout();

    expect(stdout).toContain('WORKFLOW');
    expect(stdout).toContain('FAIL%');
    expect(stdout).toMatch(/TOTAL\s*│\s*2\s*│/);
    expect(stdout).toContain('50.0%');
    expect(stdout).not.toContain('secret-free');
  });
});
