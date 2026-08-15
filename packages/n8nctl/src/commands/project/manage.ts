import { Command } from 'commander';
import { withAction } from '../../lib/runtime.js';
import { confirmPrompt } from '../../lib/prompt.js';
import { ValidationError } from '../../lib/errors.js';
import { rethrowWithLicenseHint } from '../../lib/license.js';
import { printMutation } from '../../lib/output.js';
import { c } from '../../lib/io.js';
import type { Factory } from '../../factory.js';

const PROJECT_ROLES = ['project:admin', 'project:editor', 'project:viewer'] as const;

interface ProjectRoleOpts {
  role?: string;
}
interface YesOpts {
  yes?: boolean;
}

export async function projectCreateHandler(
  factory: Factory,
  _opts: unknown,
  args: string[],
): Promise<void> {
  const [name] = args;
  const client = await factory.client();
  if (factory.flags.dryRun) {
    await printMutation(
      { io: factory.io, opts: factory.flags },
      { name, dryRun: true },
      `${c.yellow('[dry-run]')} would create project "${name}"\n`,
    );
    return;
  }
  try {
    const created = await client.post<{ id?: string; name?: string }>('/projects', { name });
    await printMutation(
      { io: factory.io, opts: factory.flags },
      { id: created?.id, name: created?.name ?? name },
      `${c.green('✓')} created project ${c.bold(created?.id ?? '')} "${created?.name ?? name}"\n`,
    );
  } catch (err) {
    rethrowWithLicenseHint(err, 'Projects');
  }
}

export async function projectUpdateHandler(
  factory: Factory,
  _opts: unknown,
  args: string[],
): Promise<void> {
  const [id, name] = args;
  const client = await factory.client();
  if (factory.flags.dryRun) {
    await printMutation(
      { io: factory.io, opts: factory.flags },
      { id, name, dryRun: true },
      `${c.yellow('[dry-run]')} would rename project ${c.bold(id)} → "${name}"\n`,
    );
    return;
  }
  try {
    await client.put(`/projects/${encodeURIComponent(id)}`, { name });
  } catch (err) {
    rethrowWithLicenseHint(err, 'Projects');
  }
  await printMutation(
    { io: factory.io, opts: factory.flags },
    { id, name },
    `${c.green('✓')} renamed project ${c.bold(id)} → "${name}"\n`,
  );
}

export async function projectDeleteHandler(
  factory: Factory,
  opts: YesOpts,
  args: string[],
): Promise<void> {
  const [id] = args;
  const client = await factory.client();
  if (factory.flags.dryRun) {
    await printMutation(
      { io: factory.io, opts: factory.flags },
      { id, dryRun: true },
      `${c.yellow('[dry-run]')} would delete project ${c.bold(id)}\n`,
    );
    return;
  }
  if (!opts.yes && factory.io.isTTY) {
    if (!(await confirmPrompt(`Delete project ${id}? This cannot be undone.`))) {
      factory.io.stderr.write(`${c.yellow('cancelled')}\n`);
      return;
    }
  }
  try {
    await client.delete(`/projects/${encodeURIComponent(id)}`);
  } catch (err) {
    rethrowWithLicenseHint(err, 'Projects');
  }
  await printMutation(
    { io: factory.io, opts: factory.flags },
    { id, deleted: true },
    `${c.green('✓')} deleted project ${c.bold(id)}\n`,
  );
}

export async function projectAddUserHandler(
  factory: Factory,
  opts: ProjectRoleOpts,
  args: string[],
): Promise<void> {
  const [projectId, userId] = args;
  const role = opts.role ?? 'project:viewer';
  if (!PROJECT_ROLES.includes(role as (typeof PROJECT_ROLES)[number])) {
    throw new ValidationError(`Invalid role "${role}"`, `Pick one of: ${PROJECT_ROLES.join(', ')}`);
  }
  const client = await factory.client();
  if (factory.flags.dryRun) {
    await printMutation(
      { io: factory.io, opts: factory.flags },
      { projectId, userId, role, dryRun: true },
      `${c.yellow('[dry-run]')} would add user ${c.bold(userId)} to project ${projectId} as ${role}\n`,
    );
    return;
  }
  try {
    await client.post(`/projects/${encodeURIComponent(projectId)}/users`, {
      relations: [{ userId, role }],
    });
  } catch (err) {
    rethrowWithLicenseHint(err, 'Projects');
  }
  await printMutation(
    { io: factory.io, opts: factory.flags },
    { projectId, userId, role },
    `${c.green('✓')} added ${c.bold(userId)} to project ${projectId} as ${role}\n`,
  );
}

export async function projectRemoveUserHandler(
  factory: Factory,
  opts: YesOpts,
  args: string[],
): Promise<void> {
  const [projectId, userId] = args;
  const client = await factory.client();
  if (factory.flags.dryRun) {
    await printMutation(
      { io: factory.io, opts: factory.flags },
      { projectId, userId, dryRun: true },
      `${c.yellow('[dry-run]')} would remove user ${c.bold(userId)} from project ${projectId}\n`,
    );
    return;
  }
  if (!opts.yes && factory.io.isTTY) {
    if (!(await confirmPrompt(`Remove user ${userId} from project ${projectId}?`))) {
      factory.io.stderr.write(`${c.yellow('cancelled')}\n`);
      return;
    }
  }
  try {
    await client.delete(`/projects/${encodeURIComponent(projectId)}/users/${encodeURIComponent(userId)}`);
  } catch (err) {
    rethrowWithLicenseHint(err, 'Projects');
  }
  await printMutation(
    { io: factory.io, opts: factory.flags },
    { projectId, userId, removed: true },
    `${c.green('✓')} removed ${c.bold(userId)} from project ${projectId}\n`,
  );
}

export function createProjectManageCommands(): Command[] {
  return [
    new Command('create')
      .description('Create a project (licensed: Projects)')
      .argument('<name>', 'project name')
      .action(withAction(projectCreateHandler)),
    new Command('update')
      .description('Rename a project (licensed: Projects)')
      .argument('<id>', 'project ID')
      .argument('<name>', 'new project name')
      .action(withAction(projectUpdateHandler)),
    new Command('delete')
      .alias('rm')
      .description('Delete a project (licensed: Projects)')
      .argument('<id>', 'project ID')
      .option('-y, --yes', 'Skip confirmation prompt')
      .action(withAction<YesOpts>(projectDeleteHandler)),
    new Command('add-user')
      .description('Add a user to a project (licensed: Projects)')
      .argument('<projectId>', 'project ID')
      .argument('<userId>', 'user ID')
      .option('--role <role>', `project role (${PROJECT_ROLES.join(' | ')})`, 'project:viewer')
      .action(withAction<ProjectRoleOpts>(projectAddUserHandler)),
    new Command('remove-user')
      .description('Remove a user from a project (licensed: Projects)')
      .argument('<projectId>', 'project ID')
      .argument('<userId>', 'user ID')
      .option('-y, --yes', 'Skip confirmation prompt')
      .action(withAction<YesOpts>(projectRemoveUserHandler)),
  ];
}
