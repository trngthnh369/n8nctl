import { describe, it, expect } from 'vitest';
import { makeFakeFactory } from './helpers/fake-factory.js';
import { printMutation } from '../src/lib/output.js';
import { activateHandler } from '../src/commands/workflow/activate.js';
import { deleteWorkflowHandler } from '../src/commands/workflow/delete.js';
import { createTagHandler } from '../src/commands/tag/create.js';

const FRIENDLY = 'done thing 42\n';

describe('printMutation', () => {
  it('writes ONLY the status line to stdout when no output flag is set', async () => {
    const env = makeFakeFactory();
    await printMutation({ io: env.factory.io, opts: env.factory.flags }, { id: '42' }, FRIENDLY);
    expect(env.stdout()).toBe(FRIENDLY);
    expect(env.stderr()).toBe('');
  });

  it('keeps stdout human-readable on a NON-TTY with no flag (the non-breaking guarantee)', async () => {
    // makeFakeFactory is non-TTY. printData's contract-§2 rule would turn this
    // into JSON; printMutation deliberately does not, so piping an existing
    // script through `| grep`/`| cat` keeps working across the upgrade.
    const env = makeFakeFactory();
    expect(env.factory.io.isTTY).toBe(false);
    await printMutation({ io: env.factory.io, opts: env.factory.flags }, { id: '42' }, FRIENDLY);
    expect(env.stdout()).toBe(FRIENDLY);
    expect(() => JSON.parse(env.stdout())).toThrow();
  });

  it('--json puts pure JSON on stdout and moves the status line to stderr', async () => {
    const env = makeFakeFactory({ json: true });
    await printMutation({ io: env.factory.io, opts: env.factory.flags }, { id: '42', ok: true }, FRIENDLY);
    expect(JSON.parse(env.stdout())).toEqual({ id: '42', ok: true });
    expect(env.stderr()).toBe(FRIENDLY);
  });

  it('--template renders against the mutation data', async () => {
    const env = makeFakeFactory({ template: '{{id}}' });
    await printMutation({ io: env.factory.io, opts: env.factory.flags }, { id: '42' }, FRIENDLY);
    expect(env.stdout().trim()).toBe('42');
    expect(env.stderr()).toBe(FRIENDLY);
  });
});

describe('mutation verbs honour --json end-to-end', () => {
  it('workflow activate emits parseable JSON', async () => {
    const env = makeFakeFactory({ json: true });
    env.apiMock.onPost('/workflows/42/activate').reply(200, { id: '42', name: 'wf', active: true });
    await activateHandler(env.factory, {}, ['42']);
    expect(JSON.parse(env.stdout())).toEqual({ id: '42', name: 'wf', active: true });
    expect(env.stderr()).toContain('activated workflow');
  });

  it('workflow delete emits parseable JSON even though the API returns no body', async () => {
    const env = makeFakeFactory({ json: true });
    env.apiMock.onDelete('/workflows/42').reply(200);
    await deleteWorkflowHandler(env.factory, { yes: true }, ['42']);
    expect(JSON.parse(env.stdout())).toEqual({ id: '42', deleted: true });
  });

  it('a --dry-run preview is machine-readable too, flagged with dryRun', async () => {
    const env = makeFakeFactory({ json: true, dryRun: true });
    env.apiMock.onGet('/workflows/42').reply(200, { id: '42', name: 'wf', active: true });
    await deleteWorkflowHandler(env.factory, {}, ['42']);
    expect(JSON.parse(env.stdout())).toMatchObject({ id: '42', dryRun: true });
  });

  it('tag create emits parseable JSON', async () => {
    const env = makeFakeFactory({ json: true });
    env.apiMock.onPost('/tags').reply(200, { id: 't1', name: 'prod' });
    await createTagHandler(env.factory, {}, ['prod']);
    expect(JSON.parse(env.stdout())).toEqual({ id: 't1', name: 'prod' });
  });

  it('still prints text — not JSON — when no flag is passed', async () => {
    const env = makeFakeFactory();
    env.apiMock.onPost('/workflows/42/activate').reply(200, { id: '42', name: 'wf', active: true });
    await activateHandler(env.factory, {}, ['42']);
    expect(env.stdout()).toContain('activated workflow');
    expect(() => JSON.parse(env.stdout())).toThrow();
  });
});
