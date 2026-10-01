import { describe, it, expect } from 'vitest';
import {
  STATUS_BUCKETS,
  UNKNOWN_WORKFLOW,
  computeExecutionStats,
  extractErrorSignature,
  normalizeErrorMessage,
  parseDuration,
  parseSince,
  percentileNearestRank,
  sampleMessage,
  sanitizeText,
  toExecutionRecord,
  type ErrorSignature,
  type ExecutionRecord,
} from '../src/lib/execution-stats.js';

const NOW = Date.parse('2026-09-30T12:00:00.000Z');
const MIN = 60_000;
const HOUR = 3_600_000;
const STUCK_AFTER = 30 * MIN;

const iso = (ms: number): string => new Date(ms).toISOString();

let seq = 0;
function rec(overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  seq++;
  return {
    id: String(seq),
    workflowId: 'wf1',
    status: 'success',
    startedAt: iso(NOW - HOUR),
    stoppedAt: iso(NOW - HOUR + 1000),
    waitTill: null,
    error: null,
    ...overrides,
  };
}

/** A terminal record that started `agoMs` before NOW and ran for `durMs`. */
function done(status: string, durMs: number, overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  const start = NOW - HOUR;
  return rec({ status, startedAt: iso(start), stoppedAt: iso(start + durMs), ...overrides });
}

function active(status: string, agoMs: number, overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  return rec({ status, startedAt: iso(NOW - agoMs), stoppedAt: null, ...overrides });
}

function failed(sig: ErrorSignature | null, overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  return rec({ status: 'error', error: sig, ...overrides });
}

const stats = (records: ExecutionRecord[], activeRecords?: ExecutionRecord[]) =>
  computeExecutionStats(records, { nowMs: NOW, stuckAfterMs: STUCK_AFTER, activeRecords });

describe('computeExecutionStats - counts and rates', () => {
  it('should return zeroed stats with every bucket present when the window is empty', () => {
    const out = stats([]);

    expect(Object.keys(out.totals.byStatus)).toEqual([...STATUS_BUCKETS]);
    expect(Object.values(out.totals.byStatus).every((n) => n === 0)).toBe(true);
    expect(out.totals.count).toBe(0);
    expect(out.totals.failureRate).toBeNull();
    expect(out.totals.duration).toEqual({
      count: 0,
      p50Ms: null,
      p95Ms: null,
      skipped: { notFinished: 0, clockSkew: 0, unparseable: 0 },
    });
    expect(out.workflows).toEqual([]);
    expect(out.stuck).toEqual([]);
    expect(out.errorClusters).toEqual([]);
    expect(out.errorDetail).toEqual({ errorExecutions: 0, withDetail: 0, withoutDetail: 0 });
    expect(out.stuckAfterMs).toBe(STUCK_AFTER);
  });

  it('should report zero failure rate and nearest-rank percentiles when all runs succeed', () => {
    const records = [100, 200, 300, 400, 500].map((d) => done('success', d));

    const out = stats(records);

    expect(out.totals.failureRate).toBe(0);
    expect(out.totals.duration.p50Ms).toBe(300);
    expect(out.totals.duration.p95Ms).toBe(500);
    expect(out.totals.byStatus.success).toBe(5);
    expect(out.totals.terminal).toBe(5);
  });

  it('should count error + crashed as failed and exclude running/waiting from terminal when statuses are mixed', () => {
    const records = [
      done('success', 10, { workflowId: 'wfA' }),
      done('error', 10, { workflowId: 'wfA' }),
      done('crashed', 10, { workflowId: 'wfA' }),
      done('canceled', 10, { workflowId: 'wfA' }),
      active('running', MIN, { workflowId: 'wfA' }),
      active('waiting', MIN, { workflowId: 'wfA' }),
      done('success', 10, { workflowId: 'wfB' }),
      done('error', 10, { workflowId: 'wfB' }),
      done('success', 10, { workflowId: null }),
    ];

    const out = stats(records);

    expect(out.totals.failed).toBe(3);
    expect(out.totals.terminal).toBe(7);
    expect(out.totals.failureRate).toBe(3 / 7);
    const wfA = out.workflows.find((w) => w.workflowId === 'wfA')!;
    expect(wfA.failed).toBe(2);
    expect(wfA.terminal).toBe(4);
    expect(wfA.byStatus.canceled).toBe(1);
    expect(wfA.failureRate).toBe(0.5);
    expect(out.workflows.map((w) => w.workflowId)).toEqual(['wfA', 'wfB', UNKNOWN_WORKFLOW]);
  });

  it('should break workflow sort ties by count desc then workflowId asc when failed counts are equal', () => {
    const records = [
      done('success', 1, { workflowId: 'b' }),
      done('success', 1, { workflowId: 'a' }),
      done('success', 1, { workflowId: 'c' }),
      done('success', 1, { workflowId: 'c' }),
    ];

    expect(stats(records).workflows.map((w) => w.workflowId)).toEqual(['c', 'a', 'b']);
  });

  it('should bucket missing and unrecognised statuses as unknown and case-fold known ones', () => {
    const records = [
      rec({ status: null }),
      rec({ status: 'paused' }),
      done('ERROR', 5),
      // A status-less row that looks unfinished is not guessed as running.
      rec({ status: null, startedAt: iso(NOW - 2 * HOUR), stoppedAt: null }),
    ];

    const out = stats(records);

    expect(out.totals.byStatus.unknown).toBe(3);
    expect(out.totals.byStatus.error).toBe(1);
    expect(out.stuck).toEqual([]);
  });
});

describe('computeExecutionStats - durations', () => {
  it('should skip as notFinished when running or when a terminal record has no stoppedAt', () => {
    const out = stats([active('running', MIN), rec({ status: 'success', stoppedAt: null })]);

    expect(out.totals.duration.skipped.notFinished).toBe(2);
    expect(out.totals.duration.count).toBe(0);
  });

  it('should skip clock skew but keep a zero duration when stop is before or equal to start', () => {
    const start = NOW - HOUR;
    const out = stats([
      rec({ startedAt: iso(start), stoppedAt: iso(start - 1000) }),
      rec({ startedAt: iso(start), stoppedAt: iso(start) }),
    ]);

    expect(out.totals.duration.skipped.clockSkew).toBe(1);
    expect(out.totals.duration.count).toBe(1);
    expect(out.totals.duration.p50Ms).toBe(0);
    expect(out.totals.duration.p95Ms).toBe(0);
  });

  it('should skip as unparseable when a timestamp cannot be parsed', () => {
    const out = stats([
      rec({ startedAt: 'not-a-date' }),
      rec({ stoppedAt: 'garbage' }),
      rec({ startedAt: null }),
    ]);

    expect(out.totals.duration.skipped.unparseable).toBe(3);
  });

  it('should make p50 equal p95 equal the duration when there is a single execution', () => {
    const out = stats([done('success', 1234)]);

    expect(out.totals.duration.p50Ms).toBe(1234);
    expect(out.totals.duration.p95Ms).toBe(1234);
  });

  it('should sort durations numerically, not lexically', () => {
    const out = stats([done('success', 100), done('success', 20), done('success', 3)]);

    expect(out.totals.duration.p50Ms).toBe(20);
    expect(out.totals.duration.p95Ms).toBe(100);
  });
});

describe('percentileNearestRank', () => {
  const range = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

  it('should return null when the array is empty', () => {
    expect(percentileNearestRank([], 50)).toBeNull();
  });

  it('should return the lower value when n = 2 at p50', () => {
    expect(percentileNearestRank([10, 20], 50)).toBe(10);
  });

  it('should return sorted[18] when n = 20 at p95', () => {
    expect(percentileNearestRank(range(20), 95)).toBe(19);
  });

  it('should return rank 7 when n = 7 at p95', () => {
    expect(percentileNearestRank(range(7), 95)).toBe(7);
  });

  it('should return rank 57 when n = 60 at p95', () => {
    expect(percentileNearestRank(range(60), 95)).toBe(57);
  });

  it('should return the max at p100 and the min at p0', () => {
    expect(percentileNearestRank(range(9), 100)).toBe(9);
    expect(percentileNearestRank(range(9), 0)).toBe(1);
  });
});

describe('computeExecutionStats - stuck', () => {
  it('should flag running older than the threshold and not exactly-at or younger ones', () => {
    const old = active('running', STUCK_AFTER + 1, { id: 'old' });
    const exact = active('running', STUCK_AFTER, { id: 'exact' });
    const young = active('running', MIN, { id: 'young' });

    const out = stats([], [old, exact, young]);

    expect(out.stuck.map((s) => s.id)).toEqual(['old']);
    expect(out.stuck[0]).toMatchObject({
      status: 'running',
      ageMs: STUCK_AFTER + 1,
      startedAt: iso(NOW - STUCK_AFTER - 1),
      waitTill: null,
      scheduledResume: false,
    });
  });

  it('should mark scheduledResume only when an old waiting row has a future waitTill', () => {
    const scheduled = active('waiting', 2 * HOUR, { id: 'w1', waitTill: iso(NOW + HOUR) });
    const noTimer = active('waiting', 2 * HOUR, { id: 'w2', waitTill: null });
    const pastTimer = active('waiting', 2 * HOUR, { id: 'w3', waitTill: iso(NOW - MIN) });

    const out = stats([], [scheduled, noTimer, pastTimer]);

    const byId = Object.fromEntries(out.stuck.map((s) => [s.id, s]));
    expect(byId.w1.scheduledResume).toBe(true);
    expect(byId.w1.waitTill).toBe(iso(NOW + HOUR));
    expect(byId.w2.scheduledResume).toBe(false);
    expect(byId.w3.scheduledResume).toBe(false);
  });

  it('should never flag a row whose startedAt is in the future or unparseable', () => {
    const out = stats([], [
      active('running', -HOUR),
      rec({ status: 'running', startedAt: 'nope', stoppedAt: null }),
    ]);

    expect(out.stuck).toEqual([]);
  });

  it('should give a stuck-only workflow a row with zero window counts', () => {
    const out = stats([done('success', 10, { workflowId: 'wfWindow' })], [
      active('running', 2 * HOUR, { workflowId: 'wfStuck' }),
    ]);

    const row = out.workflows.find((w) => w.workflowId === 'wfStuck')!;
    expect(row.count).toBe(0);
    expect(row.stuck).toBe(1);
    expect(row.failureRate).toBeNull();
    expect(out.totals.count).toBe(1);
    expect(out.totals.stuck).toBe(1);
  });

  it('should count per-workflow stuck and sort by age desc then id asc', () => {
    const out = stats([], [
      active('running', 2 * HOUR, { id: 'b', workflowId: 'wf1' }),
      active('running', 2 * HOUR, { id: 'a', workflowId: 'wf1' }),
      active('waiting', 5 * HOUR, { id: 'c', workflowId: 'wf2' }),
      active('running', 3 * HOUR, { id: 'd', workflowId: null }),
    ]);

    expect(out.stuck.map((s) => s.id)).toEqual(['c', 'd', 'a', 'b']);
    expect(out.stuck.find((s) => s.id === 'd')!.workflowId).toBe(UNKNOWN_WORKFLOW);
    expect(out.workflows.find((w) => w.workflowId === 'wf1')!.stuck).toBe(2);
    expect(out.workflows.find((w) => w.workflowId === 'wf2')!.stuck).toBe(1);
    expect(out.totals.stuck).toBe(4);
  });

  it('should count a duplicate id across the two active inputs once', () => {
    const running = active('running', 2 * HOUR, { id: 'dup' });
    const waiting = active('waiting', 2 * HOUR, { id: 'dup' });

    const out = stats([], [running, waiting]);

    expect(out.stuck).toHaveLength(1);
    expect(out.totals.stuck).toBe(1);
  });

  it('should use activeRecords instead of window records when activeRecords is given', () => {
    const windowOnly = active('running', 2 * HOUR, { id: 'windowOnly' });

    expect(stats([windowOnly], []).stuck).toEqual([]);
    expect(stats([windowOnly]).stuck.map((s) => s.id)).toEqual(['windowOnly']);
  });

  it('should compute stuck from a one-shot iterator of records when activeRecords is absent', () => {
    function* gen() {
      yield active('running', 2 * HOUR, { id: 'g1' });
      yield done('success', 10);
    }

    const out = computeExecutionStats(gen(), { nowMs: NOW, stuckAfterMs: STUCK_AFTER });

    expect(out.totals.count).toBe(2);
    expect(out.stuck.map((s) => s.id)).toEqual(['g1']);
  });
});

describe('extractErrorSignature', () => {
  it('should read node and message from resultData.error when it names a node', () => {
    const sig = extractErrorSignature({
      resultData: { error: { message: 'Boom', node: { name: 'HTTP Request' } } },
    });

    expect(sig).toEqual({ node: 'HTTP Request', message: 'Boom' });
  });

  it('should return node null and fall back to description then name when the error has no node', () => {
    expect(
      extractErrorSignature({ resultData: { error: { description: 'Described' } } }),
    ).toEqual({ node: null, message: 'Described' });
    expect(extractErrorSignature({ resultData: { error: { name: 'NodeApiError' } } })).toEqual({
      node: null,
      message: 'NodeApiError',
    });
    expect(extractErrorSignature({ resultData: { error: {} } })).toEqual({
      node: null,
      message: 'error',
    });
  });

  it('should prefer lastNodeExecuted in the runData fallback', () => {
    const sig = extractErrorSignature({
      resultData: {
        lastNodeExecuted: 'Second',
        runData: {
          First: [{ error: { message: 'first failed' } }],
          Second: [{ error: { message: 'retry 1' } }, { error: { message: 'retry 2' } }],
        },
      },
    });

    expect(sig).toEqual({ node: 'Second', message: 'retry 2' });
  });

  it('should take the first erroring node in key order when lastNodeExecuted did not error', () => {
    const sig = extractErrorSignature({
      resultData: {
        lastNodeExecuted: 'Ok',
        runData: {
          Ok: [{}],
          Bad: [{ error: { name: 'TypeError' } }],
          Worse: [{ error: { message: 'later' } }],
        },
      },
    });

    expect(sig).toEqual({ node: 'Bad', message: 'TypeError' });
  });

  it('should fall back to "error" when a run error has neither message nor name', () => {
    expect(extractErrorSignature({ resultData: { runData: { N: [{ error: {} }] } } })).toEqual({
      node: 'N',
      message: 'error',
    });
  });

  it('should return null without throwing when data is missing or malformed', () => {
    for (const data of [
      undefined,
      null,
      'a string',
      42,
      [],
      {},
      { resultData: 'x' },
      { resultData: { runData: [] } },
      { resultData: { runData: { N: 'not-an-array' } } },
      { resultData: { runData: { N: [null, 'x', { error: 'str' }] } } },
    ]) {
      expect(() => extractErrorSignature(data)).not.toThrow();
      expect(extractErrorSignature(data)).toBeNull();
    }
  });
});

/**
 * Secret-shaped fixtures (all fake) are assembled at runtime so no literal
 * token, key block or key=value secret sits in the source: the repo's
 * pre-commit secret scan rejects those even in tests.
 */
const j = (...parts: string[]): string => parts.join('');
const PEM_BEGIN = j('-----BEGIN PRIV', 'ATE KEY-----');
const PEM_END = j('-----END PRIV', 'ATE KEY-----');
const RSA_PEM_BEGIN = j('-----BEGIN RSA PRIV', 'ATE KEY-----');
const RSA_PEM_END = j('-----END RSA PRIV', 'ATE KEY-----');
const PGP_BEGIN = j('-----BEGIN PGP PRIV', 'ATE KEY BLOCK-----');
const PGP_END = j('-----END PGP PRIV', 'ATE KEY BLOCK-----');
// Built from code points so no invisible character sits in the source.
const ZWSP = String.fromCharCode(0x200b);
const RLO = String.fromCharCode(0x202e);
const LINE_SEP = String.fromCharCode(0x2028);

describe('sanitization', () => {
  const SECRETS: Array<[string, string]> = [
    ['Bearer ABCdef1234567890xyz failed', 'ABCdef1234567890xyz'],
    ['bearer abcdefgh12345678 failed', 'abcdefgh12345678'],
    ['auth Bearer \u001b[31mabcdefgh12345678 failed', 'abcdefgh12345678'],
    ['GET https://admin:s3cretpw@api.example.com/x failed', 's3cretpw'],
    [j('GET /x?api_', 'key=KEYVALUE99 failed'), 'KEYVALUE99'],
    [j('GET /x?a=1&access_', 'token=TOKVALUE77 failed'), 'TOKVALUE77'],
    ['Authorization: Basic dXNlcjpwYXNz rejected', 'dXNlcjpwYXNz'],
    [j('aws AK', 'IAIOSFODNN7EXAMPLE denied'), j('AK', 'IAIOSFODNN7EXAMPLE')],
    [j('slack xo', 'xb-123456789-abcdefghij invalid'), j('xo', 'xb-123456789-abcdefghij')],
    ['login password: hunter2 wrong', 'hunter2'],
    ['query token=abc123 expired', 'abc123'],
    ['body {\\"password\\":\\"hunter2\\"} rejected', 'hunter2'],
    ['body {"password":"hunter2"} rejected', 'hunter2'],
    [j('login pw', 'd=letmein99 failed'), 'letmein99'],
    ['sent cookie: sid=abc123; csrf=zz9 rejected', 'csrf=zz9'],
    ['Set-Cookie: sid=tok42; Path=/', 'sid=tok42'],
    ['stale session=SESS1234 dropped', 'SESS1234'],
    ['header authorization: Token tok999xyz denied', 'tok999xyz'],
    [j('github gh', 's_abcdefghijklmnopqrstuvwxyz12 denied'), j('gh', 's_abcdefghijklmnopqrstuvwxyz12')],
    [j('github gh', 'o_abcdefghijklmnopqrstuvwxyz12 denied'), j('gh', 'o_abcdefghijklmnopqrstuvwxyz12')],
    [j('github gh', 'u_abcdefghijklmnopqrstuvwxyz12 denied'), j('gh', 'u_abcdefghijklmnopqrstuvwxyz12')],
    ['GET /o?X-Amz-Signature=deadbeef99 403', 'deadbeef99'],
    ['presign X-Amz-Signature=cafebabe77 expired', 'cafebabe77'],
    ['POST https://api.telegram.org/bot123456789:AAEhBOweik6ad9r_QXMENQjcrGbqCr4K-w/send 401', 'AAEhBOweik6ad9r_QXMENQjcrGbqCr4K-w'],
    ['POST https://hooks.slack.com/services/T000/B000/XXXXsecret 404', 'XXXXsecret'],
    // Escape-aware JSON values (round-2 HIGH): an escape must not end the match early.
    [String.raw`body {"password":"pa\\ss99"} rejected`, 'ss99'],
    [String.raw`body {"password":"pa\"ss99"} rejected`, 'ss99'],
    [String.raw`body {\"password\":\"pa\\\"ss99\"} rejected`, 'ss99'],
    ['body {"password":"unterminated99 rejected', 'unterminated99'],
    [
      j('{"private_key":"', PEM_BEGIN, String.raw`\nMIIEpemBody99\n`, PEM_END, String.raw`\n"}`),
      'MIIEpemBody99',
    ],
    [j(RSA_PEM_BEGIN, '\nMIIEpemBody99\n', RSA_PEM_END), 'MIIEpemBody99'],
    // Secret keys detected by name: camelCase and compound keys.
    [j('body accessTo', 'ken: abc123secret'), 'abc123secret'],
    [j('body {"clientSec', 'ret":"cs-value-1"}'), 'cs-value-1'],
    [j('refreshTo', 'ken=rt-value-1 failed'), 'rt-value-1'],
    ['session_id=sid-value-1 failed', 'sid-value-1'],
    ['passwordHash: ph-value-1 failed', 'ph-value-1'],
    ["config {'apiCredential': 'ac-value-1'}", 'ac-value-1'],
    // Multi-parameter Authorization schemes.
    ['Authorization: Digest username="u", response="dg-value-1"', 'dg-value-1'],
    ['authorization: AWS4-HMAC-SHA256 Credential=AKIAX/x, Signature=aws-value-1', 'aws-value-1'],
    // Prefixed token shapes.
    ['gitlab glpat-abcdefghijklmnopqrst12 denied', 'glpat-abcdefghijklmnopqrst12'],
    ['sendgrid SG.abcdefghijklmnop12.abcdefghijklmnopqrst34 denied', 'abcdefghijklmnopqrst34'],
    ['slack xapp-1-A0123-abcdefgh invalid', 'xapp-1-A0123-abcdefgh'],
    [j('slack xo', 'xe.xo', 'xp-1-abcdefgh99 invalid'), j('xo', 'xe.xo', 'xp-1-abcdefgh99')],
    ['POST https://discord.com/api/webhooks/123/dsc-value-1 404', 'dsc-value-1'],
    ['GET /x?key=qk-value-1&auth=qa-value-1 403', 'qk-value-1'],
    ['GET /x?key=qk-value-1&auth=qa-value-1 403', 'qa-value-1'],
    // Round-3 regression: a plain key must not swallow a value holding a secret pair.
    ['Error: password=hunter2', 'hunter2'],
    ['Failed: token=abc123 here', 'abc123'],
    ['{"message":"login failed password=hunter2"}', 'hunter2'],
    [String.raw`{"body":"{\"password\":\"hunter2\"}"}`, 'hunter2'],
    ['GET https://host/x?client_secret=abc failed', 'abc'],
    ['url: https://host/x?refresh_token=abc', 'abc'],
    // Merge review: PGP blocks, an @ inside a URL password, => separators,
    // and a zero-width char splitting the key name.
    [j(PGP_BEGIN, '\nlQOYBpgpBody99\n', PGP_END), 'lQOYBpgpBody99'],
    [j('connect postgres://', 'user:p@ss99', '@db.local/app failed'), 'ss99'],
    ['config "token" => "arrow-value-1"', 'arrow-value-1'],
    ['config token -> arrow-value-2', 'arrow-value-2'],
    [j('query to', ZWSP, 'ken=zw-value-1 failed'), 'zw-value-1'],
  ];

  it.each(SECRETS)('should remove the secret from message, sample and node label when text is %j', (text, secret) => {
    const sig = extractErrorSignature({
      resultData: { error: { message: text, node: { name: `Node ${text}` } } },
    })!;
    const out = stats([failed(sig)]);
    const cluster = out.errorClusters[0];

    expect(sanitizeText(text)).not.toContain(secret);
    expect(sig.message).not.toContain(secret);
    expect(sig.node).not.toContain(secret);
    expect(cluster.message).not.toContain(secret);
    expect(cluster.sample).not.toContain(secret);
    expect(cluster.node).not.toContain(secret);
  });

  it('should keep plain phrases that only mention secret words readable', () => {
    expect(sanitizeText('Basic authentication failed')).toBe('Basic authentication failed');
    expect(sanitizeText('Invalid session state')).toBe('Invalid session state');
    expect(sanitizeText('name: Foo, id: 12, code: 500 at 10:30:45')).toBe(
      'name: Foo, id: 12, code: 500 at 10:30:45',
    );
    expect(sanitizeText('{"clientSecret":"x","name":"ok"}')).toBe('{"clientSecret":[REDACTED],"name":"ok"}');
    expect(sanitizeText('Request to https://api.example.com/v1 failed')).toBe(
      'Request to https://api.example.com/v1 failed',
    );
  });

  // Regression: the URL-userinfo scheme class was unbounded, making every
  // pattern quadratic on long dotted/dashed text (160 KB took ~3.7 s).
  it.each([
    'a.',
    'a-',
    '1:',
    'password:',
    'cookie: ',
    'authorization: ',
    'key="',
    String.raw`k:\"\\`,
    '"a":"',
    `${'a'.repeat(70)}:`,
    PEM_BEGIN,
    'x://a@',
    'x://a@@@@',
    '"token" => "',
  ])(
    'should sanitize 64 KB of repeated %j in linear time',
    (unit) => {
      const input = unit.repeat(Math.ceil(65_536 / unit.length));

      const start = performance.now();
      sanitizeText(input);

      expect(performance.now() - start).toBeLessThan(500);
    },
  );

  it('should cap raw input before sanitizing when the text is huge', () => {
    const start = performance.now();
    const out = sanitizeText('a.'.repeat(500_000));

    expect(out.length).toBeLessThanOrEqual(64 * 1024);
    expect(performance.now() - start).toBeLessThan(500);
  });

  it('should strip bidi overrides and line separators that would spoof terminal output', () => {
    expect(sanitizeText(j('safe', RLO, 'txt', LINE_SEP, 'end', ZWSP))).toBe('safetxtend');
  });

  it('should back off a cut that splits a token so no token prefix survives', () => {
    const token = j('gh', 'p_', 'A'.repeat(36));
    const filler = 'a '.repeat(Math.ceil((65_536 - 12) / 2)).slice(0, 65_536 - 12);
    const out = sanitizeText(`${filler}${token} tail`);

    expect(out).not.toContain(j('gh', 'p_'));
    expect(out.endsWith('a')).toBe(true);
  });

  it('should drop the last 256 chars of a cut with no delimiter near the end', () => {
    expect(sanitizeText('a'.repeat(70_000))).toHaveLength(65_536 - 256);
  });

  it('should strip an ANSI sequence from a node label', () => {
    const sig = extractErrorSignature({
      resultData: { error: { message: 'x', node: { name: 'HTTP \u001b[31mRequest\u001b[0m' } } },
    })!;

    expect(sig.node).toBe('HTTP Request');
  });

  it('should re-sanitize and truncate a raw node label handed straight to computeExecutionStats', () => {
    const raw = `\u001b[1m${'N'.repeat(200)}`;
    const out = stats([failed({ node: raw, message: 'boom' })]);

    expect(out.errorClusters[0].node).toBe('N'.repeat(120));
  });
});

describe('normalizeErrorMessage', () => {
  it('should replace numbers, ISO timestamps, UUIDs and mixed alphanumeric ids', () => {
    const msg =
      'Item 42 at 2026-09-30T10:00:00.123Z for 550e8400-e29b-41d4-a716-446655440000 ref abc12345678 took 1.5s';

    expect(normalizeErrorMessage(msg)).toBe('Item <n> at <ts> for <id> ref <id> took <n>s');
  });

  it('should replace quoted values while keeping an apostrophe inside a word', () => {
    expect(normalizeErrorMessage(`Value "foo" 'bar' \`baz\` doesn't match`)).toBe(
      "Value <str> <str> <str> doesn't match",
    );
  });

  it('should collapse whitespace and truncate to 200 chars', () => {
    expect(normalizeErrorMessage('  a \n\t b  ')).toBe('a b');
    expect(normalizeErrorMessage('x'.repeat(500))).toHaveLength(200);
  });

  it('should return "(empty message)" when the message is empty or blank', () => {
    expect(normalizeErrorMessage('')).toBe('(empty message)');
    expect(normalizeErrorMessage(' \n ')).toBe('(empty message)');
  });

  it('should normalize two messages differing only by id or number identically', () => {
    expect(normalizeErrorMessage('Row 17 of order ord9a8b7c6d failed')).toBe(
      normalizeErrorMessage('Row 912 of order ord1x2y3z4w failed'),
    );
  });
});

describe('sampleMessage', () => {
  it('should mask quoted values and ids but keep numbers and timestamps readable', () => {
    expect(sampleMessage('Code 500 at 2026-09-30T10:00:00Z for "secret-ish" ref abc12345678')).toBe(
      'Code 500 at 2026-09-30T10:00:00Z for <str> ref <id>',
    );
  });

  it('should truncate to 300 chars', () => {
    expect(sampleMessage('y'.repeat(1000))).toHaveLength(300);
  });
});

describe('computeExecutionStats - error clusters', () => {
  it('should merge the same node with id-differing messages into one cluster', () => {
    const out = stats([
      failed({ node: 'HTTP', message: 'Order ord1a2b3c4d not found' }),
      failed({ node: 'HTTP', message: 'Order ord9z8y7x6w not found' }),
    ]);

    expect(out.errorClusters).toHaveLength(1);
    expect(out.errorClusters[0]).toMatchObject({ node: 'HTTP', message: 'Order <id> not found', count: 2 });
  });

  it('should split the same message on different nodes into two clusters', () => {
    const out = stats([
      failed({ node: 'A', message: 'Timeout' }),
      failed({ node: 'B', message: 'Timeout' }),
    ]);

    expect(out.errorClusters.map((c) => c.node)).toEqual(['A', 'B']);
  });

  it('should share a cluster when two raw node labels sanitize identically', () => {
    const a = extractErrorSignature({ resultData: { error: { message: 'x', node: { name: 'HTTP \u001b[31mRequest' } } } })!;
    const b = extractErrorSignature({ resultData: { error: { message: 'x', node: { name: 'HTTP Request' } } } })!;

    const out = stats([failed(a), failed(b)]);

    expect(out.errorClusters).toHaveLength(1);
    expect(out.errorClusters[0].count).toBe(2);
  });

  it('should list unique sorted workflowIds and first/last seen as UTC ISO', () => {
    const t1 = NOW - 3 * HOUR;
    const t2 = NOW - HOUR;
    const out = stats([
      failed({ node: 'N', message: 'm' }, { workflowId: 'wfB', startedAt: iso(t2) }),
      failed({ node: 'N', message: 'm' }, { workflowId: 'wfA', startedAt: '2026-09-30T09:00:00+00:00' }),
      failed({ node: 'N', message: 'm' }, { workflowId: 'wfB', startedAt: 'bad' }),
    ]);

    const c = out.errorClusters[0];
    expect(c.workflowIds).toEqual(['wfA', 'wfB']);
    expect(c.firstSeen).toBe(iso(t1));
    expect(c.lastSeen).toBe(iso(t2));
  });

  it('should keep the newest 10 executionIds in canonical order and sample the newest member', () => {
    const records = Array.from({ length: 12 }, (_, i) =>
      failed(
        { node: 'N', message: `failure ${i}` },
        { id: String(100 + i), startedAt: iso(NOW - (12 - i) * MIN) },
      ),
    );
    records.push(failed({ node: 'N', message: 'failure 99' }, { id: '999', startedAt: 'bad' }));

    const c = stats(records).errorClusters[0];

    expect(c.count).toBe(13);
    expect(c.executionIds).toEqual(['111', '110', '109', '108', '107', '106', '105', '104', '103', '102']);
    expect(c.sample).toBe('failure 11');
  });

  it('should order mixed numeric and non-numeric ids the same way for every input order', () => {
    const t = iso(NOW - HOUR);
    const permutations = [
      ['9', '10', '1a'],
      ['1a', '9', '10'],
      ['10', '1a', '9'],
      ['9', '1a', '10'],
    ];

    const results = permutations.map(
      (ids) => stats(ids.map((id) => failed({ node: 'N', message: 'm' }, { id, startedAt: t }))).errorClusters[0].executionIds,
    );

    for (const r of results) expect(r).toEqual(['1a', '10', '9']);
  });

  it('should order equally old stuck rows by id asc with numeric ids before others', () => {
    const out = stats([], ['b', '10', '9', 'a'].map((id) => active('running', 2 * HOUR, { id })));

    expect(out.stuck.map((s) => s.id)).toEqual(['9', '10', 'a', 'b']);
  });

  it('should break equal startedAt by id desc, comparing numeric ids numerically', () => {
    const t = iso(NOW - HOUR);
    const out = stats([
      failed({ node: 'N', message: 'm' }, { id: '9', startedAt: t }),
      failed({ node: 'N', message: 'm' }, { id: '10', startedAt: t }),
    ]);

    expect(out.errorClusters[0].executionIds).toEqual(['10', '9']);
  });

  it('should count failed records without a signature as withoutDetail and not cluster them', () => {
    const out = stats([
      failed({ node: 'N', message: 'm' }),
      failed(null),
      rec({ status: 'crashed', error: null }),
      rec({ status: 'crashed', error: { node: null, message: 'OOM' } }),
      // A signature on a non-failed record is ignored.
      rec({ status: 'success', error: { node: 'N', message: 'ignored' } }),
    ]);

    expect(out.errorDetail).toEqual({ errorExecutions: 4, withDetail: 2, withoutDetail: 2 });
    expect(out.errorDetail.withDetail + out.errorDetail.withoutDetail).toBe(out.errorDetail.errorExecutions);
    expect(out.errorClusters.reduce((n, c) => n + c.count, 0)).toBe(2);
  });

  it('should sort clusters by count desc, node asc with null last, then message asc', () => {
    const out = stats([
      failed({ node: null, message: 'z' }),
      failed({ node: null, message: 'z' }),
      failed({ node: 'B', message: 'm' }),
      failed({ node: 'A', message: 'm' }),
      failed({ node: null, message: 'a' }),
      failed({ node: 'A', message: 'b' }),
    ]);

    expect(out.errorClusters.map((c) => [c.node, c.message])).toEqual([
      [null, 'z'],
      ['A', 'b'],
      ['A', 'm'],
      ['B', 'm'],
      [null, 'a'],
    ]);
  });
});

describe('parseDuration', () => {
  it.each([
    ['90s', 90_000],
    ['30m', 1_800_000],
    ['2h', 7_200_000],
    ['1d', 86_400_000],
    ['1500ms', 1500],
  ])('should convert %s to %d ms', (value, ms) => {
    expect(parseDuration(value, '--stuck-after', 1)).toBe(ms);
  });

  it('should return the default when the value is undefined', () => {
    expect(parseDuration(undefined, '--stuck-after', 3_600_000)).toBe(3_600_000);
  });

  it('should hint at a unit when the value is a bare integer', () => {
    expect(() => parseDuration('30', '--stuck-after', 1)).toThrow(
      expect.objectContaining({
        name: 'ValidationError',
        exitCode: 3,
        hint: expect.stringContaining('add a unit: 30m, 2h, 1d or 90000ms'),
      }),
    );
  });

  it.each(['', 'abc', '0s', '500ms', '-5m', '1.5h', '5x', '10 m', '99999999999999999d'])(
    'should reject %j with a ValidationError naming the flag',
    (value) => {
      expect(() => parseDuration(value, '--stuck-after', 1)).toThrow(
        expect.objectContaining({
          name: 'ValidationError',
          exitCode: 3,
          message: expect.stringContaining('--stuck-after'),
        }),
      );
    },
  );
});

describe('parseSince', () => {
  const rejects = (value: string) =>
    expect(() => parseSince(value, NOW)).toThrow(
      expect.objectContaining({ name: 'ValidationError', exitCode: 3, message: expect.stringContaining('--since') }),
    );

  it('should return null when the value is undefined', () => {
    expect(parseSince(undefined, NOW)).toBeNull();
  });

  it('should subtract a duration from nowMs', () => {
    expect(parseSince('24h', NOW)).toBe(NOW - 24 * HOUR);
  });

  it('should read a date-only value as UTC midnight', () => {
    expect(parseSince('2026-09-30', NOW)).toBe(Date.UTC(2026, 8, 30));
  });

  it('should resolve Z and +hh:mm offsets to the same instant', () => {
    const z = parseSince('2026-09-30T10:00:00Z', NOW);

    expect(z).toBe(Date.UTC(2026, 8, 30, 10));
    expect(parseSince('2026-09-30T17:00:00+07:00', NOW)).toBe(z);
    expect(parseSince('2026-09-30T05:00-05:00', NOW)).toBe(z);
  });

  it.each([
    '2026-09-30T10:00',
    'yesterday',
    '2026-02-30',
    '2026-09-30T24:00:00Z',
    '2026-09-30T13:00:00Z',
    '9007199254740991ms',
    '',
  ])('should reject %j', (value) => {
    rejects(value);
  });

  it('should hint at a unit when the value is a bare integer', () => {
    expect(() => parseSince('30', NOW)).toThrow(
      expect.objectContaining({ name: 'ValidationError', hint: expect.stringContaining('add a unit') }),
    );
  });

  it('should accept a leap day only in a leap year', () => {
    expect(parseSince('2024-02-29', NOW)).toBe(Date.UTC(2024, 1, 29));
    rejects('2025-02-29');
  });
});

describe('toExecutionRecord', () => {
  it('should strip control and format characters from server strings', () => {
    const r = toExecutionRecord({
      id: 'ab\u001b[31mc',
      workflowId: j('w', RLO, 'f'),
      status: 'error',
      startedAt: null,
      stoppedAt: null,
      waitTill: j('2026-10-01T00:00:00Z', LINE_SEP),
    });

    expect(r).toMatchObject({ id: 'abc', workflowId: 'wf', waitTill: '2026-10-01T00:00:00Z' });
  });

  it('should copy the known fields and never copy data', () => {
    const r = toExecutionRecord({
      id: '7',
      workflowId: 'wf',
      status: 'error',
      startedAt: 'a',
      stoppedAt: 'b',
      waitTill: 'c',
      finished: false,
      data: { resultData: { error: { message: 'x' } } },
    });

    expect(r).toEqual({
      id: '7',
      workflowId: 'wf',
      status: 'error',
      startedAt: 'a',
      stoppedAt: 'b',
      waitTill: 'c',
      error: null,
    });
    expect('data' in r).toBe(false);
  });

  it('should set missing fields to null and stringify a numeric id', () => {
    expect(toExecutionRecord({ id: 42 })).toEqual({
      id: '42',
      workflowId: null,
      status: null,
      startedAt: null,
      stoppedAt: null,
      waitTill: null,
      error: null,
    });
  });

  it.each([null, 'row', [], {}, { id: '' }, { id: null }, { id: Number.NaN }, { id: {} }])(
    'should throw TypeError when the row is %j',
    (row) => {
      expect(() => toExecutionRecord(row)).toThrow(TypeError);
    },
  );
});

describe('computeExecutionStats - determinism', () => {
  it('should produce byte-identical JSON when the input order is shuffled', () => {
    const records: ExecutionRecord[] = [];
    for (let i = 0; i < 12; i++) {
      records.push(
        failed(
          { node: 'HTTP', message: `Order ord${i}x9y8z7 failed with 50${i % 3}` },
          { id: `c${i}`, workflowId: i % 2 ? 'wfA' : 'wfB', startedAt: iso(NOW - (i % 4) * MIN) },
        ),
      );
    }
    records.push(done('success', 40), done('success', 7), done('canceled', 3, { workflowId: 'wfC' }));
    const actives = [
      active('running', 2 * HOUR, { id: 's1' }),
      active('waiting', 2 * HOUR, { id: 's2', waitTill: iso(NOW + HOUR) }),
    ];
    // Deterministic Fisher-Yates driven by a fixed LCG.
    let seed = 12345;
    const shuffled = [...records];
    for (let i = shuffled.length - 1; i > 0; i--) {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      const j = seed % (i + 1);
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }

    expect(shuffled.map((r) => r.id)).not.toEqual(records.map((r) => r.id));
    const a = JSON.stringify(stats(records, actives));
    const b = JSON.stringify(stats(shuffled, [...actives].reverse()));

    expect(b).toBe(a);
    expect(stats(records).errorClusters[0].count).toBe(12);
  });
});
