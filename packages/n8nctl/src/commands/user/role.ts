import { Command } from 'commander';
import { withAction } from '../../lib/runtime.js';
import { ValidationError } from '../../lib/errors.js';
import { rethrowWithLicenseHint } from '../../lib/license.js';
import { printMutation } from '../../lib/output.js';
import { c } from '../../lib/io.js';
import type { Factory } from '../../factory.js';

const GLOBAL_ROLES = ['global:admin', 'global:member'] as const;

export async function userRoleHandler(
  factory: Factory,
  _opts: unknown,
  args: string[],
): Promise<void> {
  const [id, role] = args;
  if (!GLOBAL_ROLES.includes(role as (typeof GLOBAL_ROLES)[number])) {
    throw new ValidationError(`Invalid role "${role}"`, `Pick one of: ${GLOBAL_ROLES.join(', ')}`);
  }
  const client = await factory.client();

  if (factory.flags.dryRun) {
    await printMutation(
      { io: factory.io, opts: factory.flags },
      { id, role, dryRun: true },
      `${c.yellow('[dry-run]')} would set role of ${c.bold(id)} → ${role}\n`,
    );
    return;
  }

  try {
    await client.patch(`/users/${encodeURIComponent(id)}/role`, { newRoleName: role });
  } catch (err) {
    rethrowWithLicenseHint(err, 'User management');
  }
  await printMutation(
    { io: factory.io, opts: factory.flags },
    { id, role },
    `${c.green('✓')} set role of ${c.bold(id)} → ${role}\n`,
  );
}

export function createRoleCommand(): Command {
  return new Command('role')
    .description("Change a user's global role (licensed: user management)")
    .argument('<id>', 'user id or email')
    .argument('<role>', `new role (${GLOBAL_ROLES.join(' | ')})`)
    .action(withAction(userRoleHandler));
}
