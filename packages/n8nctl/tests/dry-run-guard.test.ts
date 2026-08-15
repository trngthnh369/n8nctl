import { describe, it, expect } from 'vitest';
import { makeFakeFactory } from './helpers/fake-factory.js';
import { activateHandler } from '../src/commands/workflow/activate.js';
import { deactivateHandler } from '../src/commands/workflow/deactivate.js';

/**
 * `--dry-run` is a safety flag: a caller uses it to see what a script WOULD do
 * to production. activate/deactivate ignored it and performed the mutation
 * anyway — found by running `--dry-run deactivate` against a live instance and
 * watching it print "deactivated" instead of "[dry-run]".
 *
 * These tests assert the absence of the write call, not just the wording, so
 * the guard cannot regress into a cosmetic message change.
 */
describe('--dry-run must not mutate (activate / deactivate)', () => {
  it('activate issues NO POST under --dry-run', async () => {
    const env = makeFakeFactory({ dryRun: true });
    let posted = false;
    env.apiMock.onGet('/workflows/42').reply(200, { id: '42', name: 'wf', active: false });
    env.apiMock.onPost('/workflows/42/activate').reply(() => {
      posted = true;
      return [200, { id: '42', name: 'wf', active: true }];
    });

    await activateHandler(env.factory, {}, ['42']);

    expect(posted).toBe(false);
    expect(env.stdout()).toContain('[dry-run]');
    expect(env.stdout()).toContain('would activate');
  });

  it('deactivate issues NO POST under --dry-run', async () => {
    const env = makeFakeFactory({ dryRun: true });
    let posted = false;
    env.apiMock.onGet('/workflows/42').reply(200, { id: '42', name: 'wf', active: true });
    env.apiMock.onPost('/workflows/42/deactivate').reply(() => {
      posted = true;
      return [200, { id: '42', name: 'wf', active: false }];
    });

    await deactivateHandler(env.factory, {}, ['42']);

    expect(posted).toBe(false);
    expect(env.stdout()).toContain('[dry-run]');
    expect(env.stdout()).toContain('would deactivate');
  });

  it('flags a no-op so a dry run does not imply a change that will not happen', async () => {
    const env = makeFakeFactory({ dryRun: true });
    env.apiMock.onGet('/workflows/42').reply(200, { id: '42', name: 'wf', active: true });
    await activateHandler(env.factory, {}, ['42']);
    expect(env.stdout()).toContain('already active');
  });

  it('still mutates when --dry-run is absent', async () => {
    const env = makeFakeFactory();
    let posted = false;
    env.apiMock.onPost('/workflows/42/activate').reply(() => {
      posted = true;
      return [200, { id: '42', name: 'wf', active: true }];
    });
    await activateHandler(env.factory, {}, ['42']);
    expect(posted).toBe(true);
    expect(env.stdout()).toContain('activated workflow');
  });

  it('dry-run preview is machine-readable under --json', async () => {
    const env = makeFakeFactory({ dryRun: true, json: true });
    env.apiMock.onGet('/workflows/42').reply(200, { id: '42', name: 'wf', active: true });
    await deactivateHandler(env.factory, {}, ['42']);
    expect(JSON.parse(env.stdout())).toMatchObject({ id: '42', dryRun: true, alreadyInactive: false });
  });
});
