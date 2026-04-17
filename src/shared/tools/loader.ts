import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { ConfigError } from '../../lib/errors.ts';
import { logger } from '../../lib/logger.ts';
import { buildRedactor, type Redactor } from './redact.ts';
import type { ToolDefinition } from './types.ts';

const TOOL_NAME_REGEX = /^[a-z][a-z0-9-]*$/;

function isExcluded(filename: string): boolean {
  if (filename === 'types.ts' || filename === 'types.js') return true;
  if (filename === 'loader.ts' || filename === 'loader.js') return true;
  if (filename.endsWith('.test.ts') || filename.endsWith('.test.js')) return true;
  if (filename.startsWith('_')) return true;
  return false;
}

function hasRequiredFields(obj: unknown): obj is {
  name: string;
  description: string;
  inputSchema: unknown;
  handler: (...args: never[]) => unknown;
} {
  if (typeof obj !== 'object' || obj === null) return false;
  const record = obj as Record<string, unknown>;
  return (
    typeof record.name === 'string' &&
    typeof record.description === 'string' &&
    record.inputSchema !== undefined &&
    typeof record.handler === 'function'
  );
}

export interface ToolRegistry {
  list(): readonly ToolDefinition[];
  get(name: string): ToolDefinition | undefined;
  /**
   * Returns a copy of `args` with fields flagged `.meta({ sensitive: true })`
   * replaced by `'[REDACTED]'`. Used by the tool wrapper's entry log so
   * credential-bearing fields never reach the operational log stream.
   */
  redact(name: string, args: Record<string, unknown>): Record<string, unknown>;
}

export async function loadTools(toolsDir: string): Promise<ToolRegistry> {
  const entries = await readdir(toolsDir, { recursive: true });
  const tools = new Map<string, ToolDefinition>();
  const nameToFile = new Map<string, string>();
  const redactors = new Map<string, Redactor>();

  for (const entry of entries) {
    if (!entry.endsWith('.ts') && !entry.endsWith('.js')) continue;

    // Check exclusion on just the filename part (not subdirectory).
    const parts = entry.split('/');
    const filename = parts[parts.length - 1] ?? entry;
    if (isExcluded(filename)) continue;

    const fullPath = join(toolsDir, entry);
    const relPath = relative(toolsDir, fullPath);

    let mod: Record<string, unknown>;
    try {
      mod = (await import(pathToFileURL(fullPath).href)) as Record<string, unknown>;
    } catch (err) {
      throw new ConfigError(
        `Failed to import tool file "${relPath}": ${err instanceof Error ? err.message : String(err)}`,
        'Tool loading error.',
      );
    }

    const tool = mod.default;
    if (tool === undefined) {
      throw new ConfigError(`Tool file "${relPath}" has no default export`, 'Tool loading error.');
    }

    if (!hasRequiredFields(tool)) {
      throw new ConfigError(
        `Tool file "${relPath}" default export is missing required fields (name, description, inputSchema, handler)`,
        'Tool loading error.',
      );
    }

    if (!TOOL_NAME_REGEX.test(tool.name)) {
      throw new ConfigError(
        `Tool file "${relPath}" has invalid name "${tool.name}" — must match /^[a-z][a-z0-9-]*$/`,
        'Tool loading error.',
      );
    }

    const existingFile = nameToFile.get(tool.name);
    if (existingFile !== undefined) {
      throw new ConfigError(
        `Duplicate tool name "${tool.name}" in "${relPath}" and "${existingFile}"`,
        'Tool loading error.',
      );
    }

    // Validate that the Zod schema compiles.
    try {
      z.object(tool.inputSchema as z.ZodRawShape);
    } catch (err) {
      throw new ConfigError(
        `Tool file "${relPath}" has a malformed inputSchema: ${err instanceof Error ? err.message : String(err)}`,
        'Tool loading error.',
      );
    }

    const def = tool as ToolDefinition;
    if (def.outputSchema !== undefined) {
      try {
        z.object(def.outputSchema as z.ZodRawShape);
      } catch (err) {
        throw new ConfigError(
          `Tool file "${relPath}" has a malformed outputSchema: ${err instanceof Error ? err.message : String(err)}`,
          'Tool loading error.',
        );
      }
    }
    tools.set(def.name, def);
    nameToFile.set(def.name, relPath);
    redactors.set(def.name, buildRedactor(def.inputSchema as z.ZodRawShape));
    logger.debug({ tool: def.name, file: relPath }, 'loaded tool');
  }

  const identity: Redactor = (args) => args;

  return {
    list: () => [...tools.values()],
    get: (name: string) => tools.get(name),
    redact: (name, args) => (redactors.get(name) ?? identity)(args),
  };
}
