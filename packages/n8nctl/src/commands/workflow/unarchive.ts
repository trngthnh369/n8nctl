import { Command } from 'commander';
import { withAction } from '../../lib/runtime.js';
import { c } from '../../lib/io.js';
import { archiveWithVersionGuard } from './archive.js';
import type { Factory } from '../../factory.js';
import type { Workflow } from '../../types/n8n.js';

/**
 * Restore an archived workflow: `POST /workflows/{id}/unarchive` (n8n-io/n8n
 * PR #27513). Unarchiving a workflow that is not archived returns 400, which
 * maps to the standard ApiError (exit 1). Unarchiving does NOT re-activate the
 * workflow — it stays inactive; run `workflow activate` separately.
 */
export async function unarchiveHandler(
  factory: Factory,
  _opts: unknown,
  args: string[],
): Promise<void> {
  const [id] = args;
  const client = await factory.client();

  if (factory.flags.dryRun) {
    const wf = await client.get<Workflow>(`/workflows/${encodeURIComponent(id)}`);
    // The GET is already paid for, so flag the documented 400 here rather than
    // letting a --dry-run report success for a call that cannot succeed.
    const warn = wf.isArchived === false ? ' — but it is NOT archived, so this would fail (400)' : '';
    factory.io.stdout.write(
      `${c.yellow('[dry-run]')} would unarchive workflow ${c.bold(wf.id)} "${wf.name}"${warn}\n`,
    );
    return;
  }

  const result = await archiveWithVersionGuard(client, id, 'unarchive');
  factory.io.stdout.write(
    `${c.green('✓')} unarchived workflow ${c.bold(result.id)} "${result.name}" ` +
      `${c.dim('(still inactive — run `workflow activate` to enable)')}\n`,
  );
}

export function createUnarchiveCommand(): Command {
  return new Command('unarchive')
    .description('Restore an archived workflow (leaves it inactive)')
    .argument('<id>', 'workflow ID')
    .action(withAction(unarchiveHandler));
}
