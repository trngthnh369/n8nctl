import { Command } from 'commander';
import { withAction } from '../../lib/runtime.js';
import { printMutation } from '../../lib/output.js';
import { c } from '../../lib/io.js';
import type { Factory } from '../../factory.js';
import type { Workflow } from '../../types/n8n.js';

export async function activateHandler(
  factory: Factory,
  _opts: unknown,
  args: string[],
): Promise<void> {
  const [id] = args;
  const client = await factory.client();
  const result = await client.post<Workflow>(`/workflows/${encodeURIComponent(id)}/activate`);
  await printMutation(
    { io: factory.io, opts: factory.flags },
    { id: result.id, name: result.name, active: result.active },
    `${c.green('✓')} activated workflow ${c.bold(result.id)} "${result.name}"\n`,
  );
}

export function createActivateCommand(): Command {
  return new Command('activate')
    .description('Activate a workflow')
    .argument('<id>', 'workflow ID')
    .action(withAction(activateHandler));
}
