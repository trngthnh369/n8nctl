import { Command } from 'commander';
import { createListCommand } from './list.js';
import { createGetCommand } from './get.js';
import { createRetryCommand } from './retry.js';
import { createWaitCommand } from './wait.js';
import { createLastErrorCommand } from './last-error.js';
import { createLogsCommand } from './logs.js';
import { createDeleteCommand } from './delete.js';
import { createStatsCommand } from './stats.js';

export function createExecutionCommand(): Command {
  const cmd = new Command('execution')
    .alias('exec')
    .description('Inspect and manage workflow executions');
  cmd.addCommand(createListCommand());
  cmd.addCommand(createGetCommand());
  cmd.addCommand(createRetryCommand());
  cmd.addCommand(createDeleteCommand());
  // wait + last-error existed since the workspace split but were never
  // registered here — the n8n-test skill documented them against a CLI that
  // rejected them with "unknown command". Fixed in 0.7.0.
  cmd.addCommand(createWaitCommand());
  cmd.addCommand(createLastErrorCommand());
  cmd.addCommand(createLogsCommand());
  cmd.addCommand(createStatsCommand());
  return cmd;
}
