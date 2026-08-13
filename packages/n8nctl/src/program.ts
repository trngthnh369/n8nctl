import { Command, Option, InvalidArgumentError } from 'commander';
import { createRequire } from 'node:module';
import { createWorkflowCommand } from './commands/workflow/index.js';
import { createExecutionCommand } from './commands/execution/index.js';
import { createCredentialCommand } from './commands/credential/index.js';
import { createAuthCommand } from './commands/auth/index.js';
import { createConfigCommand } from './commands/config/index.js';
import { createProfileCommand } from './commands/profile/index.js';
import { createTagNoun } from './commands/tag/index.js';
import { createDoctorCommand } from './commands/doctor.js';
import { createCompletionCommand } from './commands/completion.js';
import { createVariableCommand } from './commands/variable/index.js';
import { createAuditCommand } from './commands/audit.js';
import { createUserCommand } from './commands/user/index.js';
import { createProjectCommand } from './commands/project/index.js';
import { createSourceControlCommand } from './commands/source-control/index.js';
import { createNodeCommand } from './commands/node/index.js';
import { createCatalogCommand } from './commands/catalog/index.js';
import { createMcpCommand } from './commands/mcp/index.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

/**
 * Construct the full command tree WITHOUT parsing. Separated from index.ts so
 * both the entry point (which parses) and `completion` (which walks the tree to
 * generate drift-proof shell completions) build the exact same program.
 */
export function buildProgram(): Command {
  const program = new Command();

  program
    .name('n8nctl')
    .description('CLI for managing n8n workflows via REST API')
    .version(pkg.version, '-v, --version')
    .addOption(new Option('--api-key <token>', 'API key (overrides env and config)').env('N8N_API_KEY'))
    .addOption(new Option('--host <url>', 'n8n host URL (overrides env and config)').env('N8N_HOST'))
    .option('--profile <name>', 'Use a specific profile')
    .option('--json', 'Output JSON regardless of TTY')
    .option('--jq <expr>', 'Filter output via jq expression')
    .option('--template <tmpl>', 'Format output via Handlebars template')
    .option('--timeout <ms>', 'HTTP request timeout in ms (default: 30000)', (v) => {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1) {
        // commander prints "error: option '--timeout <ms>' argument 'X' is invalid. <message>"
        throw new InvalidArgumentError('must be a positive integer (milliseconds)');
      }
      return n;
    })
    .option('--insecure', 'Disable TLS certificate verification (self-signed dev instances only)')
    .option('--dry-run', 'Preview what would change without making destructive API calls')
    .addOption(
      new Option('--log-format <fmt>', 'stderr log format (text or ndjson). NDJSON emits one JSON object per event for agent consumption.')
        .choices(['text', 'ndjson'])
        .env('N8NCTL_LOG_FORMAT'),
    )
    .showHelpAfterError();

  program.addCommand(createWorkflowCommand());
  program.addCommand(createExecutionCommand());
  program.addCommand(createCredentialCommand());
  program.addCommand(createTagNoun());
  program.addCommand(createAuthCommand());
  program.addCommand(createConfigCommand());
  program.addCommand(createProfileCommand());
  program.addCommand(createVariableCommand());
  program.addCommand(createUserCommand());
  program.addCommand(createProjectCommand());
  program.addCommand(createSourceControlCommand());
  program.addCommand(createMcpCommand());
  program.addCommand(createNodeCommand());
  program.addCommand(createCatalogCommand());
  program.addCommand(createAuditCommand());
  program.addCommand(createDoctorCommand());
  program.addCommand(createCompletionCommand(buildProgram));

  return program;
}
