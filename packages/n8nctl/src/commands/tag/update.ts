import { Command } from 'commander';
import { withAction } from '../../lib/runtime.js';
import { printMutation } from '../../lib/output.js';
import { c } from '../../lib/io.js';
import type { Factory } from '../../factory.js';
import type { WorkflowTag } from '../../types/n8n.js';

export async function updateTagHandler(
  factory: Factory,
  _opts: unknown,
  args: string[],
): Promise<void> {
  const [id, name] = args;
  const client = await factory.client();

  if (factory.flags.dryRun) {
    await printMutation(
      { io: factory.io, opts: factory.flags },
      { id, name, dryRun: true },
      `${c.yellow('[dry-run]')} would rename tag ${c.bold(id)} → "${name}"\n`,
    );
    return;
  }

  const updated = await client.put<WorkflowTag>(`/tags/${encodeURIComponent(id)}`, { name });
  await printMutation(
    { io: factory.io, opts: factory.flags },
    { id, name: updated.name },
    `${c.green('✓')} renamed tag ${c.bold(id)} → "${updated.name}"\n`,
  );
}

export function createUpdateCommand(): Command {
  return new Command('update')
    .description('Rename a tag')
    .argument('<id>', 'tag ID')
    .argument('<name>', 'new tag name')
    .action(withAction(updateTagHandler));
}
