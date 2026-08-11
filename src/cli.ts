#!/usr/bin/env node

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

import { findUnusedClasses, relativeUnusedClasses } from './core/unused.js';
import type { LocalsConvention } from './core/types.js';

type OutputFormat = 'json' | 'text';

interface CliArguments {
  aliases: Record<string, string>;
  cache: boolean;
  cacheLimit?: number;
  format: OutputFormat;
  localsConvention: LocalsConvention;
  paths: string[];
  rootDir: string;
  sassLoadPaths: string[];
}

function usage(): string {
  return [
    'Usage: css-modules-lint check-unused [paths...] [options]',
    '',
    'Options:',
    '  --root <path>                 Project root (default: current directory)',
    '  --format <text|json>          Output format (default: text)',
    '  --alias <prefix=path>         Repeatable local import alias',
    '  --sass-load-path <path>       Repeatable local Sass load path',
    '  --locals-convention <value>   asIs, camelCase, camelCaseOnly, or dashes',
    '  --no-cache                    Disable the in-memory extraction cache',
    '  --cache-limit <count>         Max cached stylesheets (default: 256)',
  ].join('\n');
}

function nextValue(args: readonly string[], index: number, option: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${option} requires a value.`);
  }
  return value;
}

function parseArguments(args: readonly string[]): CliArguments {
  if (args[0] !== 'check-unused') {
    throw new Error(usage());
  }

  const parsed: CliArguments = {
    aliases: {},
    cache: true,
    format: 'text',
    localsConvention: 'asIs',
    paths: [],
    rootDir: process.cwd(),
    sassLoadPaths: [],
  };

  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index]!;
    if (!argument.startsWith('--')) {
      parsed.paths.push(argument);
      continue;
    }

    switch (argument) {
      case '--root':
        parsed.rootDir = nextValue(args, index, argument);
        index += 1;
        break;
      case '--format': {
        const format = nextValue(args, index, argument);
        if (format !== 'text' && format !== 'json') {
          throw new Error('--format must be text or json.');
        }
        parsed.format = format;
        index += 1;
        break;
      }
      case '--alias': {
        const alias = nextValue(args, index, argument);
        const equalsIndex = alias.indexOf('=');
        const key = alias.slice(0, equalsIndex);
        const target = alias.slice(equalsIndex + 1);
        if (equalsIndex <= 0 || !target || key.includes('\0') || target.includes('\0')) {
          throw new Error('--alias must use prefix=path.');
        }
        parsed.aliases[key] = target;
        index += 1;
        break;
      }
      case '--sass-load-path':
        parsed.sassLoadPaths.push(nextValue(args, index, argument));
        index += 1;
        break;
      case '--locals-convention': {
        const convention = nextValue(args, index, argument);
        if (!['asIs', 'camelCase', 'camelCaseOnly', 'dashes'].includes(convention)) {
          throw new Error('--locals-convention is invalid.');
        }
        parsed.localsConvention = convention as LocalsConvention;
        index += 1;
        break;
      }
      case '--no-cache':
        parsed.cache = false;
        break;
      case '--cache-limit': {
        const cacheLimit = Number(nextValue(args, index, argument));
        if (!Number.isSafeInteger(cacheLimit) || cacheLimit < 1) {
          throw new Error('--cache-limit must be a positive integer.');
        }
        parsed.cacheLimit = cacheLimit;
        index += 1;
        break;
      }
      default:
        throw new Error(`Unknown option: ${argument}`);
    }
  }

  return parsed;
}

export function runCli(args: readonly string[], write: (output: string) => void = console.log): number {
  try {
    const parsed = parseArguments(args);
    const rootDir = realpathSync(resolve(parsed.rootDir));
    const result = findUnusedClasses({ ...parsed, rootDir });
    if (result.incomplete) {
      write(parsed.format === 'json'
        ? JSON.stringify({ unused: [], incomplete: true }, undefined, 2)
        : 'Unable to complete unused CSS Module class scan.');
      return 2;
    }

    const unused = relativeUnusedClasses(rootDir, result.unused);

    if (parsed.format === 'json') {
      write(JSON.stringify({ unused }, undefined, 2));
    } else if (unused.length === 0) {
      write('No unused CSS Module classes found.');
    } else {
      write(unused.map(({ stylesheet, className }) => `${stylesheet}: ${className}`).join('\n'));
    }

    return unused.length > 0 ? 1 : 0;
  } catch (error) {
    write(error instanceof Error ? error.message : 'Unable to check unused CSS Module classes.');
    return 2;
  }
}

export function runCliFromProcess(
  moduleUrl: string,
  argv: readonly string[],
  write?: (output: string) => void,
): void {
  if (argv[1] && isCliEntrypoint(moduleUrl, argv[1])) {
    process.exitCode = runCli(argv.slice(2), write);
  }
}

function isCliEntrypoint(moduleUrl: string, entryPath: string): boolean {
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(entryPath);
  } catch {
    return false;
  }
}

runCliFromProcess(import.meta.url, process.argv);
