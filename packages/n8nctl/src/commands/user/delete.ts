import { Command } from 'commander';
import { withAction } from '../../lib/runtime.js';
import { confirmPrompt } from '../../lib/prompt.js';
import { rethrowWithLicenseHint } from '../../lib/license.js';
import { printMutation } from '../../lib/output.js';
import { c } from '../../lib/io.js';
import type { Factory } from '../../factory.js';

interface UserDeleteOpts {
  yes?: boolean;
}

export async function userDeleteHandler(
  factory: Factory,
  opts: UserDeleteOpts,
  args: string[],
): Promise<void> {
  const [id] = args;
  const client = await factory.client();

  if (factory.flags.dryRun) {
    await printMutation(
      { io: factory.io, opts: factory.flags },
      { id, dryRun: true },
      `${c.yellow('[dry-run]')} would delete user ${c.bold(id)}\n`,
    );
    return;
  }

  if (!opts.yes && factory.io.isTTY) {
    if (!(await confirmPrompt(`Delete user ${id}? Their personal workflows/credentials transfer per instance policy. This cannot be undone.`))) {
      factory.io.stderr.write(`${c.yellow('cancelled')}\n`);
      return;
    }
  }

  try {
    await client.delete(`/users/${encodeURIComponent(id)}`);
  } catch (err) {
    rethrowWithLicenseHint(err, 'User management');
  }
  await printMutation(
    { io: factory.io, opts: factory.flags },
    { id, deleted: true },
    `${c.green('✓')} deleted user ${c.bold(id)}\n`,
  );
}

export function createDeleteCommand(): Command {
  return new Command('delete')
    .alias('rm')
    .description('Delete a user (licensed: user management)')
    .argument('<id>', 'user id or email')
    .option('-y, --yes', 'Skip confirmation prompt')
    .action(withAction<UserDeleteOpts>(userDeleteHandler));
}
