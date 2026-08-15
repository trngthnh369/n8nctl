import { Command } from 'commander';
import { withAction } from '../../lib/runtime.js';
import { ApiError } from '../../lib/errors.js';
import { printMutation } from '../../lib/output.js';
import { c } from '../../lib/io.js';
import { rethrowWithLicenseHint } from '../../lib/license.js';
import type { Factory } from '../../factory.js';
import type { N8nVariable } from './list.js';

/** Find a variable by key across all pages (keys are unique in n8n). */
async function findByKey(
  client: Awaited<ReturnType<Factory['client']>>,
  key: string,
): Promise<N8nVariable | undefined> {
  for await (const v of client.paginate<N8nVariable>('/variables', { limit: 100 })) {
    if (v.key === key) return v;
  }
  return undefined;
}

export async function variableSetHandler(
  factory: Factory,
  _opts: unknown,
  args: string[],
): Promise<void> {
  const [key, value] = args;
  const client = await factory.client();

  let existing: N8nVariable | undefined;
  try {
    existing = await findByKey(client, key);
  } catch (err) {
    rethrowWithLicenseHint(err, 'Variables');
  }

  if (factory.flags.dryRun) {
    await printMutation(
      { io: factory.io, opts: factory.flags },
      { key, dryRun: true },
      `${c.yellow('[dry-run]')} would ${existing ? `update variable ${existing.id}` : 'create variable'} ${c.bold(key)}\n`,
    );
    return;
  }

  if (existing) {
    try {
      await client.put(`/variables/${encodeURIComponent(existing.id)}`, { key, value });
      await printMutation(
        { io: factory.io, opts: factory.flags },
        { id: existing.id, key, updated: true },
        `${c.green('✓')} updated variable ${c.bold(key)} (${existing.id})\n`,
      );
      return;
    } catch (err) {
      // Older n8n versions have no PUT /variables — fall back to delete+create.
      if (!(err instanceof ApiError && (err.status === 404 || err.status === 405))) throw err;
      await client.delete(`/variables/${encodeURIComponent(existing.id)}`);
    }
  }

  const created = await client.post<N8nVariable>('/variables', { key, value });
  await printMutation(
    { io: factory.io, opts: factory.flags },
    { id: created?.id, key, created: true },
    `${c.green('✓')} created variable ${c.bold(key)}${created?.id ? ` (${created.id})` : ''}\n`,
  );
}

export function createSetCommand(): Command {
  return new Command('set')
    .description('Create or update a variable by key (licensed feature)')
    .argument('<key>', 'variable key')
    .argument('<value>', 'variable value')
    .action(withAction(variableSetHandler));
}
