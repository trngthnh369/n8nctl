import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { makeFakeFactory } from './helpers/fake-factory.js';
import { archiveHandler } from '../src/commands/workflow/archive.js';
import { unarchiveHandler } from '../src/commands/workflow/unarchive.js';
import { ApiError } from '../src/lib/errors.js';

// Some paths set process.exitCode via the handler; isolate it per test.
let savedExit: number | undefined;
beforeEach(() => {
  savedExit = process.exitCode;
  process.exitCode = undefined;
});
afterEach(() => {
  process.exitCode = savedExit;
});

describe('archiveHandler', () => {
  it('POSTs archive and reports success', async () => {
    const env = makeFakeFactory();
    env.apiMock.onPost('/workflows/42/archive').reply(200, { id: '42', name: 'wf', isArchived: true, active: false });
    await archiveHandler(env.factory, {}, ['42']);
    expect(env.stdout()).toContain('archived workflow');
    expect(env.stdout()).toContain('42');
  });

  it('encodes the id in the path', async () => {
    const env = makeFakeFactory();
    let hit = false;
    env.apiMock.onPost('/workflows/a%2Fb/archive').reply(() => {
      hit = true;
      return [200, { id: 'a/b', name: 'wf', isArchived: true, active: false }];
    });
    await archiveHandler(env.factory, {}, ['a/b']);
    expect(hit).toBe(true);
  });

  it('dry-run GETs and notes deactivation for an active workflow', async () => {
    const env = makeFakeFactory({ dryRun: true });
    env.apiMock.onGet('/workflows/7').reply(200, { id: '7', name: 'wf', active: true });
    await archiveHandler(env.factory, {}, ['7']);
    expect(env.stdout()).toContain('[dry-run]');
    expect(env.stdout()).toContain('would archive');
    expect(env.stdout()).toContain('deactivate');
  });

  it('dry-run omits the deactivation note for an inactive workflow', async () => {
    const env = makeFakeFactory({ dryRun: true });
    env.apiMock.onGet('/workflows/8').reply(200, { id: '8', name: 'wf', active: false });
    await archiveHandler(env.factory, {}, ['8']);
    expect(env.stdout()).toContain('would archive');
    expect(env.stdout()).not.toContain('deactivate');
  });

  it('maps a 404 on an EXISTING workflow to an endpoint-version hint', async () => {
    const env = makeFakeFactory();
    env.apiMock.onPost('/workflows/9/archive').reply(404, { message: 'not found' });
    env.apiMock.onGet('/workflows/9').reply(200, { id: '9', name: 'wf', active: false });
    await expect(archiveHandler(env.factory, {}, ['9'])).rejects.toMatchObject({
      status: 404,
      hint: expect.stringContaining('#27513'),
    });
  });

  it('surfaces a non-404 probe failure instead of misreporting it as not-found', async () => {
    const env = makeFakeFactory();
    env.apiMock.onPost('/workflows/11/archive').reply(404, { message: 'not found' });
    // The probe cannot confirm anything — reporting "verify the ID" here would
    // blame the user for what is really a server fault.
    env.apiMock.onGet('/workflows/11').reply(500, { message: 'boom' });
    await expect(archiveHandler(env.factory, {}, ['11'])).rejects.toMatchObject({ status: 500 });
  });

  it('rethrows the original 404 when the workflow is genuinely missing', async () => {
    const env = makeFakeFactory();
    env.apiMock.onPost('/workflows/nope/archive').reply(404, { message: 'not found' });
    env.apiMock.onGet('/workflows/nope').reply(404, { message: 'not found' });
    await expect(archiveHandler(env.factory, {}, ['nope'])).rejects.toBeInstanceOf(ApiError);
    // the endpoint-hint must NOT be attached — this is a real not-found
    await expect(archiveHandler(env.factory, {}, ['nope'])).rejects.not.toMatchObject({
      hint: expect.stringContaining('#27513'),
    });
  });
});

describe('unarchiveHandler', () => {
  it('POSTs unarchive and reports success + the inactive reminder', async () => {
    const env = makeFakeFactory();
    env.apiMock.onPost('/workflows/42/unarchive').reply(200, { id: '42', name: 'wf', isArchived: false, active: false });
    await unarchiveHandler(env.factory, {}, ['42']);
    expect(env.stdout()).toContain('unarchived workflow');
    expect(env.stdout()).toContain('activate');
  });

  it('propagates a 400 (workflow not archived) as an ApiError', async () => {
    const env = makeFakeFactory();
    env.apiMock.onPost('/workflows/5/unarchive').reply(400, { message: 'Workflow is not archived.' });
    await expect(unarchiveHandler(env.factory, {}, ['5'])).rejects.toBeInstanceOf(ApiError);
  });

  it('dry-run GETs without mutating', async () => {
    const env = makeFakeFactory({ dryRun: true });
    env.apiMock.onGet('/workflows/6').reply(200, { id: '6', name: 'wf', isArchived: true, active: false });
    await unarchiveHandler(env.factory, {}, ['6']);
    expect(env.stdout()).toContain('[dry-run]');
    expect(env.stdout()).toContain('would unarchive');
    expect(env.stdout()).not.toContain('would fail');
  });

  it('dry-run warns that a NOT-archived workflow would 400', async () => {
    const env = makeFakeFactory({ dryRun: true });
    env.apiMock.onGet('/workflows/6').reply(200, { id: '6', name: 'wf', isArchived: false, active: false });
    await unarchiveHandler(env.factory, {}, ['6']);
    expect(env.stdout()).toContain('would fail (400)');
  });

  it('names the unarchive verb in the endpoint-version hint', async () => {
    const env = makeFakeFactory();
    env.apiMock.onPost('/workflows/9/unarchive').reply(404, { message: 'not found' });
    env.apiMock.onGet('/workflows/9').reply(200, { id: '9', name: 'wf', active: false });
    await expect(unarchiveHandler(env.factory, {}, ['9'])).rejects.toMatchObject({
      message: expect.stringContaining('unarchive'),
      hint: expect.stringContaining('#27513'),
    });
  });
});
