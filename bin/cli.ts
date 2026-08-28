#!/usr/bin/env node
import { CommanderError } from 'commander';
import { createProgram } from '../src/index.js';
import { handleError } from '../src/lib/error.js';

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const program = createProgram(argv);
  try {
    await program.parseAsync(process.argv);
  } catch (error) {
    if (
      error instanceof CommanderError &&
      (error.code === 'commander.helpDisplayed' || error.code === 'commander.version')
    ) {
      return;
    }
    handleError(error);
  }
}

void main();
