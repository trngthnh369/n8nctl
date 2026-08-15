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

  // Without this guard `--dry-run activate` really activated the workflow —
  // every other mutation verb honours the flag, so a caller reasonably assumes
  // --dry-run is a safe way to see what a script would touch on production.
  if (factory.flags.dryRun) {
    const wf = await client.get<Workflow>(`/workflows/${encodeURIComponent(id)}`);
    await printMutation(
      { io: factory.io, opts: factory.flags },
      { id: wf.id, name: wf.name, active: wf.active, dryRun: true, alreadyActive: Boolean(wf.active) },
      `${c.yellow('[dry-run]')} would activate workflow ${c.bold(wf.id)} "${wf.name}"` +
        `${wf.active ? ' (already active — no change)' : ''}\n`,
    );
    return;
  }

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
