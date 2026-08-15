import type { TableUserConfig } from 'table';
import { ValidationError } from './errors.js';
import { scrubAnsi } from './util.js';
import type { IoStreams } from './io.js';

// `table`, `handlebars`, and `node-jq` are heavy (node-jq shells out to a jq
// binary) and only needed for specific output modes. They are lazy-imported at
// point of use so a plain `n8nctl workflow list --json` (or `--version`) never
// pays their load cost — meaningful for a CLI an agent invokes in a tight loop.

export interface OutputOptions {
  json?: boolean;
  jq?: string;
  template?: string;
  output?: string;
  /**
   * TTY default output format from config `settings.outputFormat`. An explicit
   * --json/--jq/--template flag still wins; this only picks the default when
   * stdout is a TTY. 'json' forces JSON even on a TTY; 'table' keeps the
   * table view; 'auto'/undefined = existing behaviour (table if available).
   */
  outputFormat?: 'auto' | 'json' | 'table';
}

export interface PrintContext {
  io: IoStreams;
  opts: OutputOptions;
}

export async function printData(
  data: unknown,
  ctx: PrintContext,
  tableView?: (d: unknown) => { head: string[]; rows: string[][] },
): Promise<void> {
  if (ctx.opts.jq) {
    const jq = (await import('node-jq')).default;
    const result = await jq.run(ctx.opts.jq, JSON.stringify(data), { input: 'string', output: 'json' });
    ctx.io.stdout.write(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
    ctx.io.stdout.write('\n');
    return;
  }

  if (ctx.opts.template) {
    ctx.io.stdout.write(await renderTemplate(ctx.opts.template, data));
    ctx.io.stdout.write('\n');
    return;
  }

  // Non-TTY always JSON (contract §2). On a TTY, --json or settings.outputFormat
  // === 'json' forces JSON; otherwise fall through to the table/JSON default.
  if (ctx.opts.json || !ctx.io.isTTY || ctx.opts.outputFormat === 'json') {
    ctx.io.stdout.write(JSON.stringify(data, null, 2));
    ctx.io.stdout.write('\n');
    return;
  }

  if (tableView) {
    const { table } = await import('table');
    const view = tableView(data);
    const config: TableUserConfig = {
      border: {
        topBody: '─', topJoin: '┬', topLeft: '┌', topRight: '┐',
        bottomBody: '─', bottomJoin: '┴', bottomLeft: '└', bottomRight: '┘',
        bodyLeft: '│', bodyRight: '│', bodyJoin: '│',
        joinBody: '─', joinLeft: '├', joinRight: '┤', joinJoin: '┼',
      },
    };
    // Scrub ANSI/control chars from cell values — a remote workflow name could
    // otherwise smuggle terminal escape sequences into a TTY (the JSON/NDJSON
    // paths are already escaped by JSON.stringify).
    const scrubRow = (row: string[]): string[] => row.map((cell) => scrubAnsi(String(cell)));
    ctx.io.stdout.write(table([scrubRow(view.head), ...view.rows.map(scrubRow)], config));
    return;
  }

  ctx.io.stdout.write(JSON.stringify(data, null, 2));
  ctx.io.stdout.write('\n');
}

/**
 * Report the outcome of a state-changing command.
 *
 * Mutation verbs (activate, archive, delete, tag create, …) print a status line
 * rather than a document, so they historically bypassed `printData` entirely —
 * which meant `--json` silently did nothing and a script doing
 * `n8nctl workflow archive X --json | jq` got human text and failed to parse.
 *
 * This is deliberately OPT-IN rather than the full contract §2 behaviour: with
 * no output flag the status line still goes to stdout exactly as before, so
 * existing scripts that pipe these commands keep working. Only an explicit
 * `--json` / `--jq` / `--template` switches stdout to machine-readable data,
 * and then the human line moves to stderr so stdout stays pure.
 *
 * Takes a PrintContext rather than a Factory on purpose — `lib/output.ts` must
 * not depend on `factory.ts`, which would close an import cycle.
 */
export async function printMutation(
  ctx: PrintContext,
  data: unknown,
  friendly: string,
): Promise<void> {
  const machineReadable = Boolean(ctx.opts.json || ctx.opts.jq || ctx.opts.template);
  if (!machineReadable) {
    ctx.io.stdout.write(friendly);
    return;
  }
  ctx.io.stderr.write(friendly);
  await printData(data, ctx);
}

/**
 * Render a user-supplied Handlebars template against data.
 *
 * Sandboxing decisions:
 * - Use `Handlebars.create()` per render so registered helpers don't leak
 *   between commands and template state is isolated.
 * - `noEscape: true` — output is terminal text, not HTML.
 * - `strict: true` — reference to an undefined property throws instead of
 *   silently rendering empty string. Catches template typos early.
 * - `assumeObjects: false` — do not assume every reference is an object.
 * - Do NOT enable `compat` mode — skips legacy look-up behaviors that could
 *   aid prototype traversal.
 *
 * Helpers exposed: `newline`, `json` (pretty-print a value).
 */
export async function renderTemplate(template: string, data: unknown): Promise<string> {
  const Handlebars = (await import('handlebars')).default;
  const hb = Handlebars.create();
  hb.registerHelper('newline', () => '\n');
  hb.registerHelper('json', (value: unknown) => JSON.stringify(value, null, 2));

  const compiled = hb.compile(template, {
    noEscape: true,
    strict: true,
    assumeObjects: false,
  });

  try {
    return compiled(data);
  } catch (err) {
    throw new ValidationError(
      `Template render failed: ${(err as Error).message}`,
      'Check that all referenced fields exist in the data.',
    );
  }
}

export function validateOutputOptions(opts: OutputOptions): void {
  const flags = [opts.json, !!opts.jq, !!opts.template].filter(Boolean).length;
  if (flags > 1) {
    throw new ValidationError(
      'Only one of --json, --jq, --template may be used at once.',
    );
  }
}
