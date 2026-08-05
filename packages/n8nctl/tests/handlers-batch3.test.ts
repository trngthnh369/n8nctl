import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeFakeFactory } from './helpers/fake-factory.js';
import { listExecutionsHandler } from '../src/commands/execution/list.js';
import { waitHandler } from '../src/commands/execution/wait.js';
import { listCredentialsHandler } from '../src/commands/credential/list.js';
import { configListHandler } from '../src/commands/config/list.js';
import { profileListHandler } from '../src/commands/profile/list.js';
import { profileSwitchHandler } from '../src/commands/profile/switch.js';
import { completionHandler } from '../src/commands/completion.js';
import { createFactory } from '../src/factory.js';
import { buildProgram } from '../src/program.js';
import { ValidationError, AuthError } from '../src/lib/errors.js';

let cfgDir: string;
let savedExit: number | undefined;
let savedEnv: Record<string, string | undefined>;

beforeEach(async () => {
  cfgDir = await fs.mkdtemp(path.join(os.tmpdir(), 'n8nctl-b3-'));
  process.env.N8NCTL_CONFIG_DIR = cfgDir;
  savedExit = process.exitCode;
  process.exitCode = undefined;
  savedEnv = { key: process.env.N8N_API_KEY, host: process.env.N8N_HOST };
  delete process.env.N8N_API_KEY;
  delete process.env.N8N_HOST;
});

afterEach(async () => {
  delete process.env.N8NCTL_CONFIG_DIR;
  if (savedEnv.key !== undefined) process.env.N8N_API_KEY = savedEnv.key;
  if (savedEnv.host !== undefined) process.env.N8N_HOST = savedEnv.host;
  process.exitCode = savedExit;
  await fs.rm(cfgDir, { recursive: true, force: true });
});

describe('execution list / wait handlers', () => {
  it('list passes filters and prints rows', async () => {
    const env = makeFakeFactory({ json: true });
    let params: Record<string, unknown> = {};
    env.apiMock.onGet('/executions').reply((cfg) => {
      params = cfg.params as Record<string, unknown>;
      return [200, { data: [{ id: 'e1', workflowId: 'w1', status: 'success' }] }];
    });
    await listExecutionsHandler(env.factory, { workflow: 'w1', status: 'success', limit: '5' }, []);
    expect(params).toMatchObject({ workflowId: 'w1', status: 'success', limit: 5 });
    expect(env.stdout()).toContain('"e1"');
  });

  it('list rejects a non-numeric --limit before any API call', async () => {
    const env = makeFakeFactory();
    await expect(listExecutionsHandler(env.factory, { limit: 'abc' }, [])).rejects.toThrow(
      ValidationError,
    );
  });

  it('wait exits 0 on success terminal state', async () => {
    const env = makeFakeFactory({ json: true });
    env.apiMock.onGet('/executions/e1').reply(200, { id: 'e1', status: 'success', finished: true });
    await waitHandler(env.factory, { timeout: '5000' }, ['e1']);
    expect(process.exitCode).toBeUndefined();
    expect(env.stderr()).toContain('success');
  });

  it('wait sets exitCode 1 on error terminal state', async () => {
    const env = makeFakeFactory({ json: true });
    env.apiMock.onGet('/executions/e1').reply(200, { id: 'e1', status: 'error', finished: true });
    await waitHandler(env.factory, { timeout: '5000' }, ['e1']);
    expect(process.exitCode).toBe(1);
  });
});

describe('credential list handler', () => {
  it('derives credentials from workflow nodes and counts usage', async () => {
    const env = makeFakeFactory({ json: true });
    const wfWithCred = (id: string, name: string) => ({
      id,
      name,
      nodes: [
        {
          name: 'Sheet',
          type: 'n8n-nodes-base.googleSheets',
          credentials: { googleSheetsOAuth2Api: { id: 'c1', name: 'My Google' } },
        },
      ],
      connections: {},
    });
    env.apiMock.onGet('/workflows').reply(200, {
      data: [wfWithCred('w1', 'A'), wfWithCred('w2', 'B')],
      nextCursor: null,
    });
    await listCredentialsHandler(env.factory, {}, []);
    const list = JSON.parse(env.stdout());
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: 'c1', type: 'googleSheetsOAuth2Api' });
    expect(list[0].usedInWorkflows).toEqual(['A', 'B']);
  });

  it('filters by --type', async () => {
    const env = makeFakeFactory({ json: true });
    env.apiMock.onGet('/workflows').reply(200, {
      data: [
        {
          id: 'w1',
          name: 'A',
          nodes: [
            { name: 'N1', type: 't', credentials: { typeA: { id: 'c1', name: 'a' } } },
            { name: 'N2', type: 't', credentials: { typeB: { id: 'c2', name: 'b' } } },
          ],
          connections: {},
        },
      ],
      nextCursor: null,
    });
    await listCredentialsHandler(env.factory, { type: 'typeB' }, []);
    const list = JSON.parse(env.stdout());
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe('c2');
  });
});

describe('config list / profile handlers (temp config)', () => {
  it('config list masks apiKey values', async () => {
    await fs.writeFile(
      path.join(cfgDir, 'config.yml'),
      'activeProfile: p1\nprofiles:\n  p1:\n    host: https://h1\n    apiKey: super-secret-key\n',
    );
    const env = makeFakeFactory();
    await configListHandler(env.factory, {}, []);
    expect(env.stdout()).toContain('***redacted***');
    expect(env.stdout()).not.toContain('super-secret-key');
  });

  it('profile list shows entries with active marker', async () => {
    await fs.writeFile(
      path.join(cfgDir, 'config.yml'),
      'activeProfile: p1\nprofiles:\n  p1:\n    host: https://h1\n  p2:\n    host: https://h2\n',
    );
    const env = makeFakeFactory({ json: true });
    await profileListHandler(env.factory, {}, []);
    const list = JSON.parse(env.stdout());
    expect(list).toHaveLength(2);
    expect(list.find((p: { name: string }) => p.name === 'p1').active).toBe(true);
  });

  it('profile list reports when no profiles exist', async () => {
    const env = makeFakeFactory();
    await profileListHandler(env.factory, {}, []);
    expect(env.stderr()).toContain('no profiles');
  });

  it('profile switch updates activeProfile', async () => {
    await fs.writeFile(
      path.join(cfgDir, 'config.yml'),
      'activeProfile: p1\nprofiles:\n  p1:\n    host: https://h1\n  p2:\n    host: https://h2\n',
    );
    const env = makeFakeFactory();
    await profileSwitchHandler(env.factory, {}, ['p2']);
    expect(env.stdout()).toContain('switched to profile "p2"');
    const yml = await fs.readFile(path.join(cfgDir, 'config.yml'), 'utf8');
    expect(yml).toContain('activeProfile: p2');
  });

  it('profile switch rejects unknown profile', async () => {
    const env = makeFakeFactory();
    await expect(profileSwitchHandler(env.factory, {}, ['ghost'])).rejects.toThrow(ValidationError);
  });
});

describe('completion handler', () => {
  it('prints a bash completion script', async () => {
    const env = makeFakeFactory();
    await completionHandler(env.factory, {}, ['bash'], buildProgram);
    expect(env.stdout()).toContain('_n8nctl_complete');
  });

  it('prints scripts for zsh, fish, and powershell', async () => {
    for (const shell of ['zsh', 'fish', 'powershell']) {
      const env = makeFakeFactory();
      await completionHandler(env.factory, {}, [shell], buildProgram);
      expect(env.stdout().length).toBeGreaterThan(50);
    }
  });

  it('rejects unsupported shells', async () => {
    const env = makeFakeFactory();
    await expect(completionHandler(env.factory, {}, ['tcsh'], buildProgram)).rejects.toThrow(ValidationError);
  });
});

describe('createFactory (real factory wiring)', () => {
  it('builds io + flags and lazily fails auth with empty config and no env', async () => {
    const factory = createFactory({});
    expect(factory.io.stdout).toBeDefined();
    expect(typeof factory.io.event).toBe('function');
    await expect(factory.client()).rejects.toThrow(AuthError);
  });

  it('resolves client from explicit flag overrides without touching config', async () => {
    const factory = createFactory({ apiKey: 'k', host: 'https://flag.example.com' });
    const client = await factory.client();
    expect(client.host).toBe('https://flag.example.com');
    // cached on second call
    expect(await factory.client()).toBe(client);
  });
});
