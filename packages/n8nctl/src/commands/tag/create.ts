import { Command } from 'commander';
import { withAction } from '../../lib/runtime.js';
import { printMutation } from '../../lib/output.js';
import { c } from '../../lib/io.js';
import type { Factory } from '../../factory.js';
import type { WorkflowTag } from '../../types/n8n.js';

export async function createTagHandler(
  factory: Factory,
  _opts: unknown,
  args: string[],
): Promise<void> {
  const [name] = args;
  const client = await factory.client();
  if (factory.flags.dryRun) {
    await printMutation(
      { io: factory.io, opts: factory.flags },
      { name, dryRun: true },
      `${c.yellow('[dry-run]')} would create tag "${name}"\n`,
    );
    return;
  }
  const created = await client.post<WorkflowTag>('/tags', { name });
  await printMutation(
    { io: factory.io, opts: factory.flags },
    { id: created.id, name: created.name },
    `${c.green('✓')} created tag ${c.bold(created.id)} "${created.name}"\n`,
  );
}

export function createCreateCommand(): Command {
  return new Command('create')
    .description('Create a new tag')
    .argument('<name>', 'tag name')
    .action(withAction(createTagHandler));
}
