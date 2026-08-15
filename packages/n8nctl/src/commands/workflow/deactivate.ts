import { Command } from 'commander';
import { withAction } from '../../lib/runtime.js';
import { printMutation } from '../../lib/output.js';
import { c } from '../../lib/io.js';
import type { Factory } from '../../factory.js';
import type { Workflow } from '../../types/n8n.js';

export async function deactivateHandler(
  factory: Factory,
  _opts: unknown,
  args: string[],
): Promise<void> {
  const [id] = args;
  const client = await factory.client();
  const result = await client.post<Workflow>(`/workflows/${encodeURIComponent(id)}/deactivate`);
  await printMutation(
    { io: factory.io, opts: factory.flags },
    { id: result.id, name: result.name, active: result.active },
    `${c.yellow('○')} deactivated workflow ${c.bold(result.id)} "${result.name}"\n`,
  );
}

export function createDeactivateCommand(): Command {
  return new Command('deactivate')
    .description('Deactivate a workflow')
    .argument('<id>', 'workflow ID')
    .action(withAction(deactivateHandler));
}
