import fs from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';
import { config } from '../config.js';
import { createBrowserAutomation } from '../browser/automation.js';
import {
  collectWorkspaceSnapshot as collectFilesystemSnapshot,
  createFilesystemMcpServer,
} from '../mcp/filesystemServer.js';
import { runTerminalCommand } from '../sandbox/manager.js';

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
  {
    name: 'run_skill',
    description:
      'Execute an enabled LocalClaw skill from the governed skill registry.',
    plannerArgs:
      '{"name":"scaffold_node_http_service","input":{"projectName":"phase4-sample-app"}}',
    argsSchema: z.object({
      name: z.string().min(1),
      input: z.record(z.string(), z.unknown()).default({}),
    }),
  },
  {
    name: 'surf_web',
    description: 'Fetch and extract text content from a public URL.',
    plannerArgs: '{"url":"https://example.com/docs"}',
    argsSchema: z.object({
      url: z.string().url(),
    }),
  },
  {
    name: 'run_terminal_command',
    description: 'Execute a bash command to fetch dependencies, run tests, or manage packages locally.',
    plannerArgs: '{"command":"npm install"}',
    argsSchema: z.object({
      command: z.string().min(1),
    }),
  },
  {
    name: 'browser_automate',
    description:
      'Drive an isolated browser profile for local UI testing with navigation, click/fill actions, screenshots, console capture, and DOM assertions.',
    plannerArgs:
      '{"url":"http://127.0.0.1:3000","actions":[{"type":"wait_for","selector":"body"},{"type":"assert_text","selector":"body","value":"Hello"}],"captureScreenshot":true}',
    argsSchema: z.object({
      url: z.string().url(),
      actions: z
        .array(
          z.object({
            type: z.enum(['click', 'fill', 'press', 'wait_for', 'assert_text']),
            selector: z.string().min(1),
            value: z.string().optional(),
            timeoutMs: z.number().int().positive().max(120000).optional(),
          })
        )
        .max(50)
        .default([]),
      screenshotPath: z.string().min(1).optional(),
      captureScreenshot: z.boolean().default(true),
      headless: z.boolean().default(true),
      waitUntil: z.enum(['load', 'domcontentloaded', 'networkidle', 'commit']).optional(),
      timeoutMs: z.number().int().positive().max(120000).optional(),
    }),
  },
  {
    name: 'bootstrap_model',
    description: 'Safely download massive external neural network weights (Civitai/HF) to the secure external SSD.',
    plannerArgs: '{"url":"https://civitai.com/api/...", "filename":"AnimeArt.safetensors"}',
    argsSchema: z.object({
      url: z.string().url(),
      filename: z.string().min(1),
    }),
  },
  {
    name: 'system_prune',
    description: 'Clean up temporary files, old logs, and build artifacts to free up disk space.',
    plannerArgs: '{"target":"logs","days":7}',
    argsSchema: z.object({
    target: z.enum(['logs', 'build_artifacts', 'temp_workspaces', 'backups']),
    days: z.number().int().positive().default(7),
    }),
    },
    {
    name: 'security_audit',
    description: 'Perform a deep security scan on a file or the whole workspace to detect secrets, vulnerabilities, or risky patterns.',
    plannerArgs: '{"path":"src/auth.js","depth":"deep"}',
    argsSchema: z.object({
    path: z.string().default('.'),
    depth: z.enum(['quick', 'deep']).default('deep'),
    }),
    },
    ];
export const TOOL_NAMES = TOOL_DEFINITIONS.map((tool) => tool.name);

export async function collectWorkspaceSnapshot(workspaceRoot, options = {}) {
  return collectFilesystemSnapshot(workspaceRoot, options);
}

export function createToolRegistry(options = {}) {
  const skillManager = options.skillManager ?? null;
  const browserAutomation = options.browserAutomation ?? createBrowserAutomation();
  const filesystemServer =
    options.filesystemServer ??
    options.mcpRegistry?.getServer?.('filesystem') ??
    createFilesystemMcpServer();
  const toolMap = new Map(TOOL_DEFINITIONS.map((tool) => [tool.name, tool]));
  const filesystemToolNames = new Set([
    'make_dir',
    'write_file',
    'append_file',
    'read_file',
    'list_files',
  ]);

  async function runBuiltInTool(name, args, context) {
    const workspaceRoot = context.workspaceRoot;

    if (filesystemToolNames.has(name)) {
      return filesystemServer.callTool(name, args, { workspaceRoot });
    }

    switch (name) {
      case 'surf_web': {
        try {
          const response = await fetch(args.url);
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const text = await response.text();
          const cleanText = text
            .replace(/<style[^>]*>.*<\/style>/gis, '')
            .replace(/<script[^>]*>.*<\/script>/gis, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 15000);
            
          return {
            summary: `Fetched text from ${args.url}`,
            output: cleanText || 'No visible text found on page.',
            artifacts: [],
          };
        } catch (error) {
          throw new Error(`Failed to surf web: ${error.message}`);
        }
      }

      case 'run_terminal_command': {
        const result = await runTerminalCommand({
          command: args.command,
          workspaceRoot,
        });
        return {
          summary: `Executed terminal command: ${args.command}`,
          output: result.output.length > 8000 ? result.output.slice(0, 8000) + '... (truncated)' : result.output,
          artifacts: [],
        };
      }

      case 'browser_automate': {
        return browserAutomation.runScenario(args, {
          workspaceRoot,
          projectTarget: context.projectTarget ?? null,
          taskId: context.taskId ?? null,
        });
      }

      case 'bootstrap_model': {
        const ssdPath = process.env.OLLAMA_MODELS || '/Volumes/Ari_SSD_01/ollama-models';
        const absolutePath = path.join(ssdPath, args.filename);
        
        const command = `curl -L "${args.url}" -o "${absolutePath}"`;
        const result = await runTerminalCommand({
          command,
          workspaceRoot,
          timeoutMs: 900000, 
        });

        return {
          summary: `Downloaded external model to ${absolutePath}`,
          output: result.output,
          artifacts: [],
        };
      }

      case 'system_prune': {
        let count = 0;
        const now = Date.now();
        const maxAgeMs = args.days * 24 * 60 * 60 * 1000;

        const cleanupDir = async (dirPath, filter = () => true) => {
          try {
            const entries = await fs.readdir(dirPath, { withFileTypes: true });
            for (const entry of entries) {
              const fullPath = path.join(dirPath, entry.name);
              const stats = await fs.stat(fullPath);
              if (now - stats.mtimeMs > maxAgeMs && filter(entry, fullPath)) {
                await fs.rm(fullPath, { recursive: true, force: true });
                count++;
              }
            }
          } catch (err) {
            // Ignore missing directories
          }
        };

        if (args.target === 'logs') {
          await cleanupDir(path.join(process.cwd(), 'logs'), (e) => e.name.endsWith('.log'));
        } else if (args.target === 'backups') {
          await cleanupDir(path.join(process.cwd(), 'db/backups'), (e) => e.name.endsWith('.sql'));
        } else if (args.target === 'build_artifacts') {
          const ssdProjects = config.ssdBasePath || '/Volumes/Ari_SSD_01/PROJECTS/localclaw';
          try {
            const projects = await fs.readdir(ssdProjects, { withFileTypes: true });
            for (const project of projects) {
              if (project.isDirectory()) {
                const projectPath = path.join(ssdProjects, project.name);
                await cleanupDir(path.join(projectPath, 'dist'));
                await cleanupDir(path.join(projectPath, 'build'));
                await cleanupDir(path.join(projectPath, '.cache'));
              }
            }
          } catch (err) {}
        }

        return {
          summary: `System prune completed for ${args.target}. Removed ${count} items.`,
          output: `Pruned ${count} items from ${args.target} target.`,
          artifacts: [],
        };
      }

      default:
        throw new Error(`Unhandled LocalClaw tool: ${name}`);
    }
  }

  return {
    listTools() {
      return TOOL_DEFINITIONS.map((tool) => ({
        name: tool.name,
        description: tool.description,
      }));
    },

    plannerCatalog() {
      const baseCatalog = TOOL_DEFINITIONS.map(
        (tool) =>
          `- ${tool.name}: ${tool.description} Args example: ${tool.plannerArgs}`
      ).join('\n');

      const skillSummary =
        typeof skillManager?.plannerSkillSummary === 'function'
          ? skillManager.plannerSkillSummary()
          : 'Skill manager not configured.';

      return `${baseCatalog}\n\nEnabled skill registry:\n${skillSummary}`;
    },

    async runTool(name, rawArgs, context) {
      const definition = toolMap.get(name);
      if (!definition) {
        throw new Error(`Unsupported LocalClaw tool: ${name}`);
      }

      const args = definition.argsSchema.parse(rawArgs ?? {});

      if (name === 'run_skill') {
        if (!skillManager?.executeSkill) {
          throw new Error('Skill manager is not configured.');
        }

        if (context?.invokedBySkill) {
          throw new Error('Nested run_skill execution is blocked by policy.');
        }

        return skillManager.executeSkill({
          name: args.name,
          input: args.input,
          workspaceRoot: context.workspaceRoot,
          taskId: context.taskId ?? null,
          toolRunner: async (childToolName, childArgs) => {
            if (childToolName === 'run_skill') {
              throw new Error('Skills cannot invoke run_skill recursively.');
            }

            const childDefinition = toolMap.get(childToolName);
            if (!childDefinition) {
              throw new Error(`Unsupported skill tool: ${childToolName}`);
            }

            const validatedChildArgs = childDefinition.argsSchema.parse(childArgs ?? {});
            return runBuiltInTool(childToolName, validatedChildArgs, {
              ...context,
              invokedBySkill: args.name,
            });
          },
        });
      }

      return runBuiltInTool(name, args, context);
    },
  };
}
