import fs from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

export const TOOL_DEFINITIONS = [
  {
    name: 'make_dir',
    description: 'Create a directory inside the workspace.',
    plannerArgs: '{"path":"docs"}',
    argsSchema: z.object({
      path: z.string().min(1),
    }),
  },
  {
    name: 'write_file',
    description: 'Create or overwrite a UTF-8 file inside the workspace.',
    plannerArgs:
      '{"path":"README.md","content":"Full file contents here","overwrite":true}',
    argsSchema: z.object({
      path: z.string().min(1),
      content: z.string(),
      overwrite: z.boolean().default(true),
    }),
  },
  {
    name: 'append_file',
    description: 'Append UTF-8 content to an existing or new file inside the workspace.',
    plannerArgs: '{"path":"README.md","content":"Additional text"}',
    argsSchema: z.object({
      path: z.string().min(1),
      content: z.string().min(1),
    }),
  },
  {
    name: 'read_file',
    description: 'Read a UTF-8 file from the workspace.',
    plannerArgs: '{"path":"README.md","maxChars":4000}',
    argsSchema: z.object({
      path: z.string().min(1),
      maxChars: z.number().int().positive().max(50000).default(8000),
    }),
  },
  {
    name: 'list_files',
    description: 'List files and directories inside the workspace.',
    plannerArgs: '{"path":".","recursive":true,"limit":50}',
    argsSchema: z.object({
      path: z.string().default('.'),
      recursive: z.boolean().default(false),
      limit: z.number().int().positive().max(200).default(50),
    }),
  },
];

export const TOOL_NAMES = TOOL_DEFINITIONS.map((tool) => tool.name);

function assertRelativePath(value) {
  if (path.isAbsolute(value)) {
    throw new Error(`Absolute paths are not allowed: ${value}`);
  }
}

function resolveWorkspacePath(workspaceRoot, relativePath = '.') {
  assertRelativePath(relativePath);

  const resolvedPath = path.resolve(workspaceRoot, relativePath);
  const relative = path.relative(workspaceRoot, resolvedPath);

  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Path escapes workspace root: ${relativePath}`);
  }

  return resolvedPath;
}

async function walkWorkspace(currentPath, workspaceRoot, recursive, limit, results) {
  if (results.length >= limit) {
    return;
  }

  const entries = await fs.readdir(currentPath, { withFileTypes: true });
  const sortedEntries = entries.sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of sortedEntries) {
    if (results.length >= limit) {
      break;
    }

    const absolutePath = path.join(currentPath, entry.name);
    const relativePath = path.relative(workspaceRoot, absolutePath) || '.';

    results.push({
      path: relativePath,
      type: entry.isDirectory() ? 'directory' : 'file',
    });

    if (recursive && entry.isDirectory()) {
      await walkWorkspace(absolutePath, workspaceRoot, recursive, limit, results);
    }
  }
}

export async function collectWorkspaceSnapshot(workspaceRoot, options = {}) {
  const startPath = resolveWorkspacePath(workspaceRoot, options.path ?? '.');
  const recursive = options.recursive ?? true;
  const limit = options.limit ?? 100;
  const results = [];

  await walkWorkspace(startPath, workspaceRoot, recursive, limit, results);
  return results;
}

export function createToolRegistry() {
  const toolMap = new Map(TOOL_DEFINITIONS.map((tool) => [tool.name, tool]));

  return {
    listTools() {
      return TOOL_DEFINITIONS.map((tool) => ({
        name: tool.name,
        description: tool.description,
      }));
    },

    plannerCatalog() {
      return TOOL_DEFINITIONS.map(
        (tool) =>
          `- ${tool.name}: ${tool.description} Args example: ${tool.plannerArgs}`
      ).join('\n');
    },

    async runTool(name, rawArgs, context) {
      const definition = toolMap.get(name);
      if (!definition) {
        throw new Error(`Unsupported LocalClaw tool: ${name}`);
      }

      const args = definition.argsSchema.parse(rawArgs ?? {});
      const workspaceRoot = context.workspaceRoot;

      switch (name) {
        case 'make_dir': {
          const absolutePath = resolveWorkspacePath(workspaceRoot, args.path);
          await fs.mkdir(absolutePath, { recursive: true });
          return {
            summary: `Created directory ${args.path}`,
            artifacts: [
              {
                artifactType: 'directory',
                artifactPath: absolutePath,
                metadata: { relativePath: args.path },
              },
            ],
          };
        }

        case 'write_file': {
          const absolutePath = resolveWorkspacePath(workspaceRoot, args.path);

          if (!args.overwrite) {
            try {
              await fs.access(absolutePath);
              throw new Error(`File already exists and overwrite=false: ${args.path}`);
            } catch (error) {
              if (error.code !== 'ENOENT') {
                throw error;
              }
            }
          }

          await fs.mkdir(path.dirname(absolutePath), { recursive: true });
          await fs.writeFile(absolutePath, args.content, 'utf8');

          return {
            summary: `Wrote file ${args.path}`,
            artifacts: [
              {
                artifactType: 'file',
                artifactPath: absolutePath,
                metadata: {
                  relativePath: args.path,
                  bytesWritten: Buffer.byteLength(args.content, 'utf8'),
                },
              },
            ],
          };
        }

        case 'append_file': {
          const absolutePath = resolveWorkspacePath(workspaceRoot, args.path);
          await fs.mkdir(path.dirname(absolutePath), { recursive: true });
          await fs.appendFile(absolutePath, args.content, 'utf8');

          return {
            summary: `Appended content to ${args.path}`,
            artifacts: [
              {
                artifactType: 'file',
                artifactPath: absolutePath,
                metadata: {
                  relativePath: args.path,
                  bytesAppended: Buffer.byteLength(args.content, 'utf8'),
                },
              },
            ],
          };
        }

        case 'read_file': {
          const absolutePath = resolveWorkspacePath(workspaceRoot, args.path);
          const content = await fs.readFile(absolutePath, 'utf8');
          const truncatedContent = content.slice(0, args.maxChars);

          return {
            summary: `Read ${args.path}`,
            output: truncatedContent,
            artifacts: [],
          };
        }

        case 'list_files': {
          const entries = await collectWorkspaceSnapshot(workspaceRoot, {
            path: args.path,
            recursive: args.recursive,
            limit: args.limit,
          });

          return {
            summary: `Listed ${entries.length} workspace entries`,
            output: entries,
            artifacts: [],
          };
        }

        default:
          throw new Error(`Unhandled LocalClaw tool: ${name}`);
      }
    },
  };
}
