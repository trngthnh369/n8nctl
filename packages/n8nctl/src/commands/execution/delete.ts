import { Command } from 'commander';
import { withAction } from '../../lib/runtime.js';
import { confirmPrompt } from '../../lib/prompt.js';
import { printMutation } from '../../lib/output.js';
import { c } from '../../lib/io.js';
import type { Factory } from '../../factory.js';

interface ExecDeleteOpts {
  yes?: boolean;
}

export async function executionDeleteHandler(
  factory: Factory,
  opts: ExecDeleteOpts,
  args: string[],
): Promise<void> {
  const [id] = args;
  const client = await factory.client();

  if (factory.flags.dryRun) {
    await printMutation(
      { io: factory.io, opts: factory.flags },
      { id, dryRun: true },
      `${c.yellow('[dry-run]')} would delete execution ${c.bold(id)}\n`,
    );
    return;
  }

  if (!opts.yes && factory.io.isTTY) {
    if (!(await confirmPrompt(`Delete execution ${id}? This cannot be undone.`))) {
      factory.io.stderr.write(`${c.yellow('cancelled')}\n`);
      return;
    }
  }

  await client.delete(`/executions/${encodeURIComponent(id)}`);
  await printMutation(
    { io: factory.io, opts: factory.flags },
    { id, deleted: true },
    `${c.green('✓')} deleted execution ${c.bold(id)}\n`,
  );
}

export function createDeleteCommand(): Command {
  return new Command('delete')
    .alias('rm')
    .description('Delete an execution record (useful for cleaning up between agent test runs)')
    .argument('<id>', 'execution ID')
    .option('-y, --yes', 'Skip confirmation prompt')
    .action(withAction<ExecDeleteOpts>(executionDeleteHandler));
}
