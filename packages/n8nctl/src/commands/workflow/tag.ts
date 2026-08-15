import { Command } from 'commander';
import { withAction } from '../../lib/runtime.js';
import { printMutation } from '../../lib/output.js';
import { c } from '../../lib/io.js';
import { ApiError, ValidationError } from '../../lib/errors.js';
import { fetchAllTags } from '../../lib/tags.js';
import type { Factory } from '../../factory.js';
import type { WorkflowTag } from '../../types/n8n.js';

interface TagOpts {
  replace?: boolean;
  create?: boolean;
}

/**
 * Commander v12 passes a variadic positional (`<tag-names...>`) to the action
 * as a single nested array. Without flattening, `args.slice(1)` becomes
 * `[ [name1, name2, ...] ]` and the inner loop sees the array itself as
 * `name`, triggering "name.toLowerCase is not a function".
 *
 * Flatten + coerce to strings so the parser is robust against both nested
 * (variadic) and flat (manual) shapes.
 */
export function parseTagArgs(args: unknown[]): { id: string; tagNames: string[] } {
  if (args.length < 2 || typeof args[0] !== 'string' || !args[0]) {
    throw new ValidationError('Missing workflow id');
  }
  const id = args[0];
  const flat = (args.slice(1) as unknown[]).flat(Infinity);
  const tagNames = flat.filter((s): s is string => typeof s === 'string' && s.length > 0);
  if (tagNames.length === 0) {
    throw new ValidationError('At least one tag name is required');
  }
  return { id, tagNames };
}

export async function tagHandler(
  factory: Factory,
  opts: TagOpts,
  args: string[],
): Promise<void> {
  const { id, tagNames } = parseTagArgs(args);
  const client = await factory.client();

  const allTags = await fetchAllTags(client);
  const byName = new Map(
    allTags
      .filter((t): t is WorkflowTag => typeof t?.name === 'string')
      .map((t) => [t.name.toLowerCase(), t]),
  );

  const resolved: WorkflowTag[] = [];
  for (const name of tagNames) {
    const existing = byName.get(name.toLowerCase());
    if (existing) {
      resolved.push(existing);
      continue;
    }
    if (!opts.create) {
      throw new ApiError(
        `Tag "${name}" not found`,
        404,
        null,
        'Pass --create to create missing tags automatically.',
      );
    }
    // --dry-run must not mutate: report the would-be creation instead
    // of POSTing (pre-0.6.0 created tags even under --dry-run).
    if (factory.flags.dryRun) {
      const placeholder = { id: '(would-create)', name } as WorkflowTag;
      resolved.push(placeholder);
      byName.set(name.toLowerCase(), placeholder);
      factory.io.stderr.write(`${c.yellow('[dry-run]')} would create tag "${name}"\n`);
      continue;
    }
    const created = await client.post<WorkflowTag>('/tags', { name });
    resolved.push(created);
    byName.set(name.toLowerCase(), created);
    factory.io.stderr.write(`${c.dim('→')} created tag "${name}" (${created.id})\n`);
  }

  let finalTagIds: string[];
  if (opts.replace) {
    finalTagIds = resolved.map((t) => t.id);
  } else {
    const current = await client.get<WorkflowTag[]>(
      `/workflows/${encodeURIComponent(id)}/tags`,
    );
    const merged = new Map(current.map((t) => [t.id, t]));
    resolved.forEach((t) => merged.set(t.id, t));
    finalTagIds = [...merged.keys()];
  }

  if (factory.flags.dryRun) {
    await printMutation(
      { io: factory.io, opts: factory.flags },
      { id, tags: resolved.map((t) => ({ id: t.id, name: t.name })), dryRun: true },
      `${c.yellow('[dry-run]')} would set tags on ${id} → [${resolved.map((t) => t.name).join(', ')}]\n`,
    );
    return;
  }

  await client.put(
    `/workflows/${encodeURIComponent(id)}/tags`,
    finalTagIds.map((tId) => ({ id: tId })),
  );
  await printMutation(
    { io: factory.io, opts: factory.flags },
    { id, tags: resolved.map((t) => ({ id: t.id, name: t.name })), replaced: Boolean(opts.replace) },
    `${c.green('✓')} tagged ${c.bold(id)} with [${resolved.map((t) => t.name).join(', ')}]\n`,
  );
}

export function createTagCommand(): Command {
  return new Command('tag')
    .description('Assign tag(s) to a workflow (appends by default, use --replace to overwrite)')
    .argument('<id>', 'workflow ID')
    .argument('<tag-names...>', 'one or more tag names')
    .option('--replace', 'Replace all existing tags instead of appending')
    .option('--create', 'Create tags that do not yet exist')
    .action(withAction<TagOpts>(tagHandler));
}
