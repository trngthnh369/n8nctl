import { Command } from 'commander';
import { withAction } from '../../lib/runtime.js';
import { ApiError } from '../../lib/errors.js';
import { printMutation } from '../../lib/output.js';
import { c } from '../../lib/io.js';
import type { Factory } from '../../factory.js';
import type { Workflow } from '../../types/n8n.js';

/**
 * Archiving is the reversible alternative to `delete` (which is permanent):
 * `POST /workflows/{id}/archive`, added to the public API in n8n-io/n8n
 * PR #27513 (merged 2026-03-27). Archiving an already-archived workflow is a
 * no-op that returns 200, so no idempotency handling is needed. n8n forces an
 * archived workflow inactive, so the returned `active` is always false.
 */
export async function archiveHandler(
  factory: Factory,
  _opts: unknown,
  args: string[],
): Promise<void> {
  const [id] = args;
  const client = await factory.client();

  if (factory.flags.dryRun) {
    const wf = await client.get<Workflow>(`/workflows/${encodeURIComponent(id)}`);
    await printMutation(
      { io: factory.io, opts: factory.flags },
      { id: wf.id, name: wf.name, active: wf.active, dryRun: true, wouldDeactivate: Boolean(wf.active) },
      `${c.yellow('[dry-run]')} would archive workflow ${c.bold(wf.id)} "${wf.name}"` +
        `${wf.active ? ' (and deactivate it)' : ''}\n`,
    );
    return;
  }

  const result = await archiveWithVersionGuard(client, id, 'archive');
  await printMutation(
    { io: factory.io, opts: factory.flags },
    { id: result.id, name: result.name, isArchived: true, active: result.active ?? false },
    `${c.green('✓')} archived workflow ${c.bold(result.id)} "${result.name}"\n`,
  );
}

/**
 * A 404 on the archive/unarchive path is ambiguous: the workflow may not exist,
 * OR the instance predates the endpoint. Disambiguate only on the error path
 * (no extra request on the happy path): re-GET the workflow — if that 404s too
 * the workflow is genuinely missing (rethrow as-is); if it succeeds, the
 * endpoint is what's missing, so surface an upgrade hint.
 */
async function archiveWithVersionGuard(
  client: Awaited<ReturnType<Factory['client']>>,
  id: string,
  verb: 'archive' | 'unarchive',
): Promise<Workflow> {
  try {
    return await client.post<Workflow>(`/workflows/${encodeURIComponent(id)}/${verb}`);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      try {
        await client.get<Workflow>(`/workflows/${encodeURIComponent(id)}`);
      } catch (probeErr) {
        // Only a CONFIRMING 404 proves the workflow is gone. Any other probe
        // failure (401 mid-command, 5xx, retries exhausted) tells us nothing
        // about the workflow, and swallowing it would report "not found —
        // verify the ID" for what is really an auth or connectivity fault.
        if (probeErr instanceof ApiError && probeErr.status === 404) throw err;
        throw probeErr;
      }
      throw new ApiError(
        `This n8n instance has no \`${verb}\` endpoint.`,
        404,
        err.body,
        'Workflow archiving was added to the n8n public API in n8n-io/n8n PR #27513 — upgrade the instance, or use `workflow delete` (permanent).',
      );
    }
    throw err;
  }
}

export { archiveWithVersionGuard };

export function createArchiveCommand(): Command {
  return new Command('archive')
    .description('Archive a workflow (reversible; use `unarchive` to restore). The safe alternative to `delete`.')
    .argument('<id>', 'workflow ID')
    .action(withAction(archiveHandler));
}
