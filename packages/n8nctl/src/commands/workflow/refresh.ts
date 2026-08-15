import { Command } from 'commander';
import { withAction } from '../../lib/runtime.js';
import { printMutation } from '../../lib/output.js';
import { c } from '../../lib/io.js';
import { sleep, parsePositiveInt } from '../../lib/util.js';
import type { Factory } from '../../factory.js';
import type { Workflow } from '../../types/n8n.js';

interface RefreshOpts {
  delay?: string | number;
}

export async function refreshHandler(
  factory: Factory,
  opts: RefreshOpts,
  args: string[],
): Promise<void> {
  const [id] = args;
  const client = await factory.client();
  const delay = parsePositiveInt(opts.delay, '--delay', 500, 0);

  const before = await client.get<Workflow>(`/workflows/${encodeURIComponent(id)}`);

  if (!before.active) {
    factory.io.stderr.write(
      `${c.yellow('!')} workflow "${before.name}" (${id}) is inactive — nothing to refresh\n` +
        `${c.dim('hint:')} run \`n8nctl workflow activate ${id}\` to set active (then UI "Save" if webhook/cron still doesn't fire)\n`,
    );
    // Exit VALUE preserved (1) — only the mechanism changes so pending
    // stream flushes are not dropped (process.exit truncates async I/O).
    process.exitCode = 1;
    return;
  }

  if (factory.flags.dryRun) {
    await printMutation(
      { io: factory.io, opts: factory.flags },
      { id, name: before.name, delayMs: delay, dryRun: true },
      `${c.yellow('[dry-run]')} would cycle "${before.name}" (${id}): deactivate → wait ${delay}ms → activate\n`,
    );
    return;
  }

  factory.io.stderr.write(`${c.dim('→')} deactivating ${id}...\n`);
  await client.post<Workflow>(`/workflows/${encodeURIComponent(id)}/deactivate`);

  if (delay > 0) {
    await sleep(delay);
  }

  factory.io.stderr.write(`${c.dim('→')} activating ${id}...\n`);
  const after = await client.post<Workflow>(`/workflows/${encodeURIComponent(id)}/activate`);

  if (!after.active) {
    factory.io.stderr.write(
      `${c.red('✗')} cycle completed but workflow is still reported inactive\n`,
    );
    process.exitCode = 1;
    return;
  }
  await printMutation(
    { io: factory.io, opts: factory.flags },
    { id, name: after.name, active: after.active, cycled: true },
    `${c.green('✓')} cycled "${after.name}" (${id}) → active\n`,
  );
  factory.io.stderr.write(
    `${c.yellow('note')}: active=true is set in the DB. If a webhook still 404s or a ` +
      `cron does not fire, the running n8n process did not re-register — do a UI "Save" ` +
      `on the workflow (or restart n8n) to register triggers.\n`,
  );
}

export function createRefreshCommand(): Command {
  return new Command('refresh')
    .description(
      'Cycle a workflow active state (deactivate → wait → activate) to nudge the ' +
        'n8n webhook/schedule router into re-registering handlers after an API update. ' +
        'NOTE: on single-main n8n this re-registers; on queue mode or a separate ' +
        'webhook process the in-process router may NOT pick it up — only a UI "Save" ' +
        '(or n8n restart) is guaranteed to register webhook/cron triggers.',
    )
    .argument('<id>', 'workflow ID')
    .option('--delay <ms>', 'Pause between deactivate and activate (default: 500)')
    .action(withAction<RefreshOpts>(refreshHandler));
}

