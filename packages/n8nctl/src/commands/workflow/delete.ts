import { Command } from 'commander';
import { withAction } from '../../lib/runtime.js';
import { confirmPrompt } from '../../lib/prompt.js';
import { printMutation } from '../../lib/output.js';
import { c } from '../../lib/io.js';
import type { Factory } from '../../factory.js';
import type { Workflow } from '../../types/n8n.js';

interface DeleteOpts {
  yes?: boolean;
}

export async function deleteWorkflowHandler(
  factory: Factory,
  opts: DeleteOpts,
  args: string[],
): Promise<void> {
  const [id] = args;
  const client = await factory.client();

  if (factory.flags.dryRun) {
    const wf = await client.get<Workflow>(`/workflows/${encodeURIComponent(id)}`);
    await printMutation(
      { io: factory.io, opts: factory.flags },
      { id: wf.id, name: wf.name, active: wf.active, dryRun: true },
      `${c.yellow('[dry-run]')} would delete workflow ${c.bold(wf.id)} "${wf.name}" (active=${wf.active})\n`,
    );
    return;
  }

  if (!opts.yes && factory.io.isTTY) {
    const confirm = await confirmPrompt(`Delete workflow ${id}? This cannot be undone.`);
    if (!confirm) {
      factory.io.stderr.write(`${c.yellow('cancelled')}\n`);
      return;
    }
  }

  await client.delete(`/workflows/${encodeURIComponent(id)}`);
  await printMutation(
    { io: factory.io, opts: factory.flags },
    { id, deleted: true },
    `${c.green('✓')} deleted workflow ${c.bold(id)}\n`,
  );
}

export function createDeleteCommand(): Command {
  return new Command('delete')
    .alias('rm')
    .description('Delete a workflow')
    .argument('<id>', 'workflow ID')
    .option('-y, --yes', 'Skip confirmation prompt')
    .action(withAction<DeleteOpts>(deleteWorkflowHandler));
}
