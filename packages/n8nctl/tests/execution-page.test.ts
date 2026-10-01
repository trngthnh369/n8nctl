import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import axios, { type AxiosInstance } from 'axios';
import MockAdapter from 'axios-mock-adapter';
import { N8nClient } from '../src/lib/api.js';
import { ApiError, NetworkError } from '../src/lib/errors.js';
import {
  fetchExecutionWindow,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  MAX_EMPTY_PAGES,
} from '../src/lib/execution-page.js';
import type { Execution } from '../src/types/n8n.js';
import type { ResolvedAuth } from '../src/lib/auth.js';

const TEST_AUTH: ResolvedAuth = {
  host: 'https://test.example.com',
  apiKey: 'k',
  profileName: 't',
  source: 'flag',
};

function makeClient() {
  const client = new N8nClient(TEST_AUTH, { baseBackoffMs: 1, timeout: 500 });
  const mock = new MockAdapter((client as unknown as { http: AxiosInstance }).http);
  return { client, mock };
}

const SINCE = Date.parse('2026-09-30T00:00:00Z');
const NEW = '2026-09-30T10:00:00Z';
const OLD = '2026-09-29T10:00:00Z';

function row(id: string, startedAt: string | null = NEW, extra: Record<string, unknown> = {}) {
  return { id, workflowId: 'wf1', status: 'success', finished: true, mode: 'trigger', startedAt, ...extra };
}

const toId = (e: unknown) => (e as Execution).id;

describe('fetchExecutionWindow', () => {
  let env: ReturnType<typeof makeClient>;
  beforeEach(() => {
    env = makeClient();
  });
  afterEach(() => {
    // Every request in this suite must carry a bounded page limit.
    for (const req of env.mock.history.get) {
      expect(req.params.limit).toBeGreaterThanOrEqual(1);
      expect(req.params.limit).toBeLessThanOrEqual(MAX_PAGE_SIZE);
    }
  });

  describe('pagination', () => {
    it('should return every item with stopReason end when one page has a null cursor', async () => {
      env.mock.onGet('/executions').replyOnce(200, { data: [row('3'), row('2'), row('1')], nextCursor: null });

      const w = await fetchExecutionWindow(env.client, { workflowId: 'wf1', limit: 1000 }, toId);

      expect(w).toEqual({ items: ['3', '2', '1'], pages: 1, truncated: false, stopReason: 'end' });
      expect(env.mock.history.get).toHaveLength(1);
      expect(env.mock.history.get[0].params).toEqual({ limit: DEFAULT_PAGE_SIZE, workflowId: 'wf1' });
    });

    it('should return an empty window when the first page has no rows', async () => {
      env.mock.onGet('/executions').replyOnce(200, { data: [], nextCursor: null });

      const w = await fetchExecutionWindow(env.client, { limit: 10 }, toId);

      expect(w).toEqual({ items: [], pages: 1, truncated: false, stopReason: 'end' });
    });

    it('should follow nextCursor and keep API order when the window spans pages', async () => {
      env.mock
        .onGet('/executions')
        .replyOnce(200, { data: [row('4'), row('3')], nextCursor: 'c1' })
        .onGet('/executions')
        .replyOnce(200, { data: [row('2'), row('1')], nextCursor: null });

      const w = await fetchExecutionWindow(env.client, { workflowId: 'wf1', limit: 1000 }, toId);

      expect(w).toEqual({ items: ['4', '3', '2', '1'], pages: 2, truncated: false, stopReason: 'end' });
      expect(env.mock.history.get[0].params.cursor).toBeUndefined();
      expect(env.mock.history.get[1].params).toEqual({ limit: DEFAULT_PAGE_SIZE, workflowId: 'wf1', cursor: 'c1' });
    });

    it('should treat an absent nextCursor key as the end', async () => {
      env.mock.onGet('/executions').replyOnce(200, { data: [row('1')] });

      const w = await fetchExecutionWindow(env.client, { limit: 10 }, toId);

      expect(w.stopReason).toBe('end');
      expect(w.truncated).toBe(false);
    });

    it('should dedupe an id seen on an earlier page', async () => {
      env.mock
        .onGet('/executions')
        .replyOnce(200, { data: [row('3'), row('2')], nextCursor: 'c1' })
        .onGet('/executions')
        .replyOnce(200, { data: [row('2'), row('1')], nextCursor: null });

      const w = await fetchExecutionWindow(env.client, { limit: 10 }, toId);

      expect(w.items).toEqual(['3', '2', '1']);
    });

    it('should dedupe a numeric id against its string form', async () => {
      env.mock.onGet('/executions').replyOnce(200, { data: [row('7'), { ...row('x'), id: 7 }], nextCursor: null });

      const w = await fetchExecutionWindow(env.client, { limit: 10 }, toId);

      expect(w.items).toEqual(['7']);
    });
  });

  describe('limit (rule 1)', () => {
    it('should stop with limit and truncated when in-window rows remain after a mid-page cut', async () => {
      env.mock.onGet('/executions').replyOnce(200, {
        data: [row('5'), row('4'), row('3'), row('2'), row('1')],
        nextCursor: null,
      });

      const w = await fetchExecutionWindow(env.client, { limit: 3 }, toId);

      expect(w).toEqual({ items: ['5', '4', '3'], pages: 1, truncated: true, stopReason: 'limit' });
      expect(env.mock.history.get).toHaveLength(1);
    });

    it('should stop with end when the limit lands on the last row and the cursor is null', async () => {
      env.mock.onGet('/executions').replyOnce(200, { data: [row('2'), row('1')], nextCursor: null });

      const w = await fetchExecutionWindow(env.client, { limit: 2 }, toId);

      expect(w).toEqual({ items: ['2', '1'], pages: 1, truncated: false, stopReason: 'end' });
    });

    it('should stop with limit and truncated when the limit lands on the last row and the cursor is not null', async () => {
      env.mock.onGet('/executions').replyOnce(200, { data: [row('2'), row('1')], nextCursor: 'c1' });

      const w = await fetchExecutionWindow(env.client, { limit: 2 }, toId);

      expect(w).toEqual({ items: ['2', '1'], pages: 1, truncated: true, stopReason: 'limit' });
      expect(env.mock.history.get).toHaveLength(1);
    });

    it('should stop with end when only duplicate rows remain after the cut and the cursor is null', async () => {
      env.mock.onGet('/executions').replyOnce(200, {
        data: [row('2'), row('1'), row('2'), row('1')],
        nextCursor: null,
      });

      const w = await fetchExecutionWindow(env.client, { limit: 2 }, toId);

      expect(w).toEqual({ items: ['2', '1'], pages: 1, truncated: false, stopReason: 'end' });
    });

    // Decision p02-a01-r01: rules 2 and 3 are judged on the whole page, so an
    // older-only tail does not by itself end the window by `since`.
    it('should stop with end when only older-than-since rows remain after the cut and the cursor is null', async () => {
      env.mock.onGet('/executions').replyOnce(200, {
        data: [row('5'), row('4'), row('3'), row('2', OLD), row('1', OLD)],
        nextCursor: null,
      });

      const w = await fetchExecutionWindow(env.client, { limit: 3, since: SINCE }, toId);

      expect(w).toEqual({ items: ['5', '4', '3'], pages: 1, truncated: false, stopReason: 'end' });
    });

    it('should stop with limit and truncated when only older rows remain after the cut and the cursor is not null', async () => {
      env.mock.onGet('/executions').replyOnce(200, {
        data: [row('5'), row('4'), row('3'), row('2', OLD), row('1', OLD)],
        nextCursor: 'c1',
      });

      const w = await fetchExecutionWindow(env.client, { limit: 3, since: SINCE }, toId);

      expect(w).toEqual({ items: ['5', '4', '3'], pages: 1, truncated: true, stopReason: 'limit' });
      expect(env.mock.history.get).toHaveLength(1);
    });

    it('should stop with since when the limit is hit on a page whose parseable rows are all older', async () => {
      env.mock.onGet('/executions').replyOnce(200, {
        data: [row('3', null), row('2', null), row('1', OLD)],
        nextCursor: 'c1',
      });

      const w = await fetchExecutionWindow(env.client, { limit: 2, since: SINCE }, toId);

      expect(w).toEqual({ items: ['3', '2'], pages: 1, truncated: false, stopReason: 'since' });
      expect(env.mock.history.get).toHaveLength(1);
    });

    it('should reject a limit that is not a positive integer before any request', async () => {
      for (const limit of [0, -1, 1.5, Number.NaN]) {
        await expect(fetchExecutionWindow(env.client, { limit }, toId)).rejects.toThrow(RangeError);
      }
      expect(env.mock.history.get).toHaveLength(0);
    });
  });

  describe('since cutoff (rules 2 and 4)', () => {
    it('should keep newer rows and request the next page when a page mixes newer and older rows', async () => {
      env.mock
        .onGet('/executions')
        .replyOnce(200, { data: [row('5'), row('4', OLD), row('3')], nextCursor: 'c1' })
        .onGet('/executions')
        .replyOnce(200, { data: [row('2', OLD), row('1', OLD)], nextCursor: 'c2' });

      const w = await fetchExecutionWindow(env.client, { limit: 100, since: SINCE }, toId);

      expect(w).toEqual({ items: ['5', '3'], pages: 2, truncated: false, stopReason: 'since' });
      expect(env.mock.history.get).toHaveLength(2);
    });

    it('should keep a newer row found on a later page when the order is not monotonic', async () => {
      env.mock
        .onGet('/executions')
        .replyOnce(200, { data: [row('5'), row('4', OLD)], nextCursor: 'c1' })
        .onGet('/executions')
        .replyOnce(200, { data: [row('3', OLD), row('2')], nextCursor: 'c2' })
        .onGet('/executions')
        .replyOnce(200, { data: [row('1', OLD)], nextCursor: 'c3' });

      const w = await fetchExecutionWindow(env.client, { limit: 100, since: SINCE }, toId);

      expect(w).toEqual({ items: ['5', '2'], pages: 3, truncated: false, stopReason: 'since' });
    });

    it('should keep a row with a null or unparseable startedAt', async () => {
      env.mock.onGet('/executions').replyOnce(200, {
        data: [row('3', null), row('2', 'not-a-date'), row('1', OLD)],
        nextCursor: null,
      });

      const w = await fetchExecutionWindow(env.client, { limit: 100, since: SINCE }, toId);

      expect(w.items).toEqual(['3', '2']);
      expect(w.stopReason).toBe('since');
    });

    it('should prefer since over end when an all-older page also has a null cursor', async () => {
      env.mock.onGet('/executions').replyOnce(200, { data: [row('1', OLD)], nextCursor: null });

      const w = await fetchExecutionWindow(env.client, { limit: 100, since: SINCE }, toId);

      expect(w).toEqual({ items: [], pages: 1, truncated: false, stopReason: 'since' });
    });

    it('should ignore a null since', async () => {
      env.mock.onGet('/executions').replyOnce(200, { data: [row('1', OLD)], nextCursor: null });

      const w = await fetchExecutionWindow(
        env.client,
        { limit: 100, since: null as unknown as number },
        toId,
      );

      expect(w).toEqual({ items: ['1'], pages: 1, truncated: false, stopReason: 'end' });
    });
  });

  describe('params', () => {
    it('should forward status running with the default page size when the limit is 500', async () => {
      env.mock.onGet('/executions').replyOnce(200, { data: [], nextCursor: null });

      await fetchExecutionWindow(env.client, { status: 'running', limit: 500 }, toId);

      expect(env.mock.history.get[0].params).toEqual({ limit: DEFAULT_PAGE_SIZE, status: 'running' });
    });

    it('should forward includeData and status error and pass data to the mapper', async () => {
      env.mock.onGet('/executions').replyOnce(200, {
        data: [row('2', NEW, { data: { n: 2 } }), row('1', NEW, { data: { n: 1 } })],
        nextCursor: null,
      });
      const seen: unknown[] = [];

      const w = await fetchExecutionWindow(
        env.client,
        { status: 'error', includeData: true, limit: 10, pageSize: 20 },
        (raw) => {
          const e = raw as Execution;
          seen.push(e.data);
          return { id: e.id };
        },
      );

      expect(env.mock.history.get[0].params).toEqual({ limit: 20, status: 'error', includeData: true });
      expect(seen).toEqual([{ n: 2 }, { n: 1 }]);
      expect(w.items).toEqual([{ id: '2' }, { id: '1' }]);
    });

    it('should clamp the page size to the API bounds', async () => {
      for (const [pageSize, expected] of [
        [1000, MAX_PAGE_SIZE],
        [undefined, DEFAULT_PAGE_SIZE],
        [0, 1],
        [Number.NaN, DEFAULT_PAGE_SIZE],
      ] as const) {
        const { client, mock } = makeClient();
        mock.onGet('/executions').replyOnce(200, { data: [], nextCursor: null });

        await fetchExecutionWindow(client, { limit: 10, pageSize }, toId);

        expect(mock.history.get[0].params.limit).toBe(expected);
      }
    });
  });

  describe('loop guards (rules 5 and 6)', () => {
    it('should reject with ApiError after exactly 2 requests when a cursor repeats', async () => {
      env.mock
        .onGet('/executions')
        .replyOnce(200, { data: [row('4'), row('3')], nextCursor: 'c1' })
        .onGet('/executions')
        .replyOnce(200, { data: [row('2'), row('1')], nextCursor: 'c1' });

      const p = fetchExecutionWindow(env.client, { limit: 100 }, toId);

      await expect(p).rejects.toBeInstanceOf(ApiError);
      await expect(p).rejects.toThrow(/repeated pagination cursor/);
      await expect(p).rejects.toMatchObject({ status: 200, body: undefined, exitCode: 1 });
      expect(env.mock.history.get).toHaveLength(2);
    });

    it('should reject with ApiError after MAX_EMPTY_PAGES duplicate-only pages with fresh cursors', async () => {
      let n = 0;
      env.mock.onGet('/executions').reply(() => {
        n++;
        if (n > 20) return [500, {}];
        return [200, { data: [row('2'), row('1')], nextCursor: `c${n}` }];
      });

      const p = fetchExecutionWindow(env.client, { limit: 100 }, toId);

      await expect(p).rejects.toThrow(/no progress/);
      await expect(p).rejects.toMatchObject({ name: 'ApiError', body: undefined });
      expect(env.mock.history.get).toHaveLength(1 + MAX_EMPTY_PAGES);
    });

    it('should end with since instead of rejecting when a repeated cursor arrives on an all-older page', async () => {
      env.mock
        .onGet('/executions')
        .replyOnce(200, { data: [row('3')], nextCursor: 'c1' })
        .onGet('/executions')
        .replyOnce(200, { data: [row('2', OLD), row('1', OLD)], nextCursor: 'c1' });

      const w = await fetchExecutionWindow(env.client, { limit: 100, since: SINCE }, toId);

      expect(w).toEqual({ items: ['3'], pages: 2, truncated: false, stopReason: 'since' });
    });

    it('should end with since instead of no progress when empty pages precede an all-older page', async () => {
      env.mock
        .onGet('/executions')
        .replyOnce(200, { data: [row('3')], nextCursor: 'c1' })
        .onGet('/executions')
        .replyOnce(200, { data: [row('3')], nextCursor: 'c2' })
        .onGet('/executions')
        .replyOnce(200, { data: [row('3')], nextCursor: 'c3' })
        .onGet('/executions')
        .replyOnce(200, { data: [row('2', OLD)], nextCursor: 'c4' });

      const w = await fetchExecutionWindow(env.client, { limit: 100, since: SINCE }, toId);

      expect(w).toEqual({ items: ['3'], pages: 4, truncated: false, stopReason: 'since' });
    });

    it('should reset the no-progress count when a page adds an item', async () => {
      env.mock
        .onGet('/executions')
        .replyOnce(200, { data: [row('9')], nextCursor: 'c1' })
        .onGet('/executions')
        .replyOnce(200, { data: [], nextCursor: 'c2' })
        .onGet('/executions')
        .replyOnce(200, { data: [], nextCursor: 'c3' })
        .onGet('/executions')
        .replyOnce(200, { data: [row('8')], nextCursor: 'c4' })
        .onGet('/executions')
        .replyOnce(200, { data: [], nextCursor: 'c5' })
        .onGet('/executions')
        .replyOnce(200, { data: [], nextCursor: null });

      const w = await fetchExecutionWindow(env.client, { limit: 100 }, toId);

      expect(w).toEqual({ items: ['9', '8'], pages: 6, truncated: false, stopReason: 'end' });
    });
  });

  describe('malformed responses', () => {
    const bodies: Array<[string, unknown]> = [
      ['an empty object', {}],
      ['a non-array data', { data: 'x' }],
      ['a numeric nextCursor', { data: [], nextCursor: 42 }],
      ['an empty-string nextCursor', { data: [], nextCursor: '' }],
      ['a null body', null],
      ['an array body', [row('1')]],
    ];
    for (const [label, body] of bodies) {
      it(`should reject with a protocol ApiError without the body when the response is ${label}`, async () => {
        env.mock.onGet('/executions').replyOnce(200, body);

        const p = fetchExecutionWindow(env.client, { limit: 10 }, toId);

        await expect(p).rejects.toThrow(/unexpected \/executions response shape/);
        await expect(p).rejects.toMatchObject({ name: 'ApiError', status: 200, body: undefined, exitCode: 1 });
        await expect(p).rejects.toHaveProperty('hint', expect.any(String));
      });
    }

    it('should name the row index and omit the row when the mapper throws', async () => {
      const secret = 'Bearer s3cr3t-token-value';
      env.mock.onGet('/executions').replyOnce(200, {
        data: [row('3'), row('2'), { id: '1', note: secret }],
        nextCursor: null,
      });
      const mapper = (raw: unknown) => {
        const e = raw as Execution;
        if (!('startedAt' in e)) throw new TypeError(`bad row ${JSON.stringify(e)}`);
        return e.id;
      };

      const err = await fetchExecutionWindow(env.client, { limit: 10 }, mapper).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).message).toMatch(/index 2/);
      expect((err as ApiError).message).not.toContain(secret);
      expect((err as ApiError).body).toBeUndefined();
    });
  });

  describe('transport errors', () => {
    it('should propagate a 401 as ApiError without retry', async () => {
      env.mock.onGet('/executions').reply(401, { message: 'unauthorized' });

      await expect(fetchExecutionWindow(env.client, { limit: 10 }, toId)).rejects.toMatchObject({
        name: 'ApiError',
        status: 401,
        exitCode: 1,
      });
      expect(env.mock.history.get).toHaveLength(1);
    });

    it('should propagate a 404 as ApiError with a hint', async () => {
      env.mock.onGet('/executions').reply(404, {});

      const err = await fetchExecutionWindow(env.client, { limit: 10 }, toId).catch((e: unknown) => e);

      expect(err).toMatchObject({ name: 'ApiError', status: 404, exitCode: 1 });
      expect((err as ApiError).hint).toBeDefined();
    });

    it('should propagate a 500 after a single request', async () => {
      env.mock.onGet('/executions').reply(500, {});

      await expect(fetchExecutionWindow(env.client, { limit: 10 }, toId)).rejects.toMatchObject({
        name: 'ApiError',
        status: 500,
      });
      expect(env.mock.history.get).toHaveLength(1);
    });

    it('should propagate a persistent 503 after maxRetries plus one requests', async () => {
      env.mock.onGet('/executions').reply(503, {});

      await expect(fetchExecutionWindow(env.client, { limit: 10 }, toId)).rejects.toMatchObject({
        name: 'ApiError',
        status: 503,
      });
      expect(env.mock.history.get).toHaveLength(4);
    });

    it('should recover when a 502 is followed by a 200', async () => {
      env.mock
        .onGet('/executions')
        .replyOnce(502, {})
        .onGet('/executions')
        .replyOnce(200, { data: [row('1')], nextCursor: null });

      const w = await fetchExecutionWindow(env.client, { limit: 10 }, toId);

      expect(w.items).toEqual(['1']);
      expect(env.mock.history.get).toHaveLength(2);
    });

    it('should propagate a network error as NetworkError with exit code 4', async () => {
      env.mock.onGet('/executions').reply(() => {
        const err = new axios.AxiosError('boom');
        err.code = 'EOTHER';
        return Promise.reject(err);
      });

      const err = await fetchExecutionWindow(env.client, { limit: 10 }, toId).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(NetworkError);
      expect((err as NetworkError).exitCode).toBe(4);
    });

    it('should reject the whole call without a partial result when page 2 fails', async () => {
      env.mock
        .onGet('/executions')
        .replyOnce(200, { data: [row('2')], nextCursor: 'c1' })
        .onGet('/executions')
        .replyOnce(500, {});

      await expect(fetchExecutionWindow(env.client, { limit: 10 }, toId)).rejects.toMatchObject({
        name: 'ApiError',
        status: 500,
      });
      expect(env.mock.history.get).toHaveLength(2);
    });
  });
});
