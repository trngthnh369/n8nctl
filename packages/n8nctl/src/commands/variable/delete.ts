import { Command } from 'commander';
import { withAction } from '../../lib/runtime.js';
import { ValidationError } from '../../lib/errors.js';
import { printMutation } from '../../lib/output.js';
import { c } from '../../lib/io.js';
import { rethrowWithLicenseHint } from '../../lib/license.js';
import type { Factory } from '../../factory.js';
import type { N8nVariable } from './list.js';

export async function variableDeleteHandler(
  factory: Factory,
  _opts: unknown,
  args: string[],
): Promise<void> {
  const [key] = args;
  const client = await factory.client();

  let target: N8nVariable | undefined;
  try {
    for await (const v of client.paginate<N8nVariable>('/variables', { limit: 100 })) {
      if (v.key === key || v.id === key) {
        target = v;
        break;
      }
    }
  } catch (err) {
    rethrowWithLicenseHint(err, 'Variables');
  }
  if (!target) {
    throw new ValidationError(`Variable "${key}" not found (searched by key and id)`);
  }

  if (factory.flags.dryRun) {
    await printMutation(
      { io: factory.io, opts: factory.flags },
      { id: target.id, key: target.key, dryRun: true },
      `${c.yellow('[dry-run]')} would delete variable ${c.bold(target.key)} (${target.id})\n`,
    );
    return;
  }

  await client.delete(`/variables/${encodeURIComponent(target.id)}`);
  await printMutation(
    { io: factory.io, opts: factory.flags },
    { id: target.id, key: target.key, deleted: true },
    `${c.green('✓')} deleted variable ${c.bold(target.key)} (${target.id})\n`,
  );
}

export function createDeleteCommand(): Command {
  return new Command('delete')
    .alias('rm')
    .description('Delete a variable by key or id (licensed feature)')
    .argument('<key>', 'variable key or id')
    .action(withAction(variableDeleteHandler));
}
