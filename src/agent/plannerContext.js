import fs from 'node:fs/promises';
import path from 'node:path';

const DOC_EXTENSIONS = new Set(['.md', '.mdx', '.txt']);
const CODE_EXTENSIONS = new Set([
  '.cjs',
  '.css',
  '.html',
  '.js',
  '.json',
  '.jsx',
  '.mjs',
  '.sql',
  '.ts',
  '.tsx',
  '.yaml',
  '.yml',
]);
const TOP_LEVEL_DOC_PRIORITY = [
  'README.md',
  'PROJECT_CONTEXT.md',
  'PROJECT_RULES.md',
  'ARCHITECTURE.md',
  'docs/ARCHITECTURE.md',
];
const DEFAULT_CRITICAL_PATHS = [
  'package.json',
  'src/index.js',
  'src/config.js',
  'src/orchestrator.js',
  'src/agent/planner.js',
];
const MAX_FULL_DOCS = 6;
const MAX_CRITICAL_FILES = 6;
const MAX_DOC_CHARS = 24_000;
const MAX_CODE_CHARS = 16_000;
const MAX_TOTAL_CHARS = 100_000;

function normalizePath(value) {
  return `${value ?? ''}`.replace(/\\/g, '/');
}

function isDocFile(relativePath) {
  return DOC_EXTENSIONS.has(path.extname(relativePath).toLowerCase());
}

function isCodeFile(relativePath) {
  return CODE_EXTENSIONS.has(path.extname(relativePath).toLowerCase());
}

function truncateText(text, maxChars) {
  const normalized = `${text ?? ''}`;
  if (normalized.length <= maxChars) {
    return {
      text: normalized,
      truncated: false,
      originalLength: normalized.length,
    };
  }

  const headLength = Math.max(Math.floor(maxChars * 0.8), maxChars - 1200);
  const tailLength = Math.max(maxChars - headLength - 32, 400);
  return {
    text: `${normalized.slice(0, headLength)}\n\n... [truncated] ...\n\n${normalized.slice(-tailLength)}`,
    truncated: true,
    originalLength: normalized.length,
  };
}

function extractReferencedPaths(task) {
  const text = `${task?.title ?? ''}\n${task?.description ?? ''}`;
  const matches = text.matchAll(
    /([A-Za-z0-9_./-]+\.(?:md|mdx|txt|json|ya?ml|cjs|mjs|js|jsx|ts|tsx|sql|sh))/g
  );

  return [...new Set(
    [...matches]
      .map((match) => normalizePath(match[1]))
      .filter(Boolean)
  )];
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function listTopLevelDocs(projectRoot) {
  const entries = await fs.readdir(projectRoot, { withFileTypes: true }).catch(() => []);
  const docs = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => isDocFile(name))
    .map((name) => normalizePath(name));

  for (const priorityPath of TOP_LEVEL_DOC_PRIORITY) {
    const absolutePath = path.join(projectRoot, priorityPath);
    if (await pathExists(absolutePath)) {
      docs.push(normalizePath(priorityPath));
    }
  }

  return [...new Set(docs)].sort((left, right) => {
    const leftPriority = TOP_LEVEL_DOC_PRIORITY.indexOf(left);
    const rightPriority = TOP_LEVEL_DOC_PRIORITY.indexOf(right);

    if (leftPriority !== -1 || rightPriority !== -1) {
      return (leftPriority === -1 ? 99 : leftPriority) - (rightPriority === -1 ? 99 : rightPriority);
    }

    return left.localeCompare(right);
  });
}

function buildCandidateCriticalPaths(task, workspaceSnapshot = []) {
  const taskText = `${task?.title ?? ''}\n${task?.description ?? ''}`.toLowerCase();
  const referencedPaths = extractReferencedPaths(task);
  const workspacePaths = workspaceSnapshot
    .map((entry) => normalizePath(entry.path))
    .filter(Boolean);
  const byTaskMention = workspacePaths.filter((entry) => taskText.includes(entry.toLowerCase()));
  const byBasenameMention = workspacePaths.filter((entry) => {
    const base = path.basename(entry).toLowerCase();
    return base.length >= 4 && taskText.includes(base);
  });

  return [...new Set([
    ...referencedPaths,
    ...byTaskMention,
    ...byBasenameMention,
    ...DEFAULT_CRITICAL_PATHS,
  ])];
}

async function collectFileBlock(projectRoot, relativePath, maxChars) {
  const normalizedPath = normalizePath(relativePath);
  const absolutePath = path.join(projectRoot, normalizedPath);
  if (!(await pathExists(absolutePath))) {
    return null;
  }

  const content = await fs.readFile(absolutePath, 'utf8').catch(() => null);
  if (typeof content !== 'string' || content.trim().length === 0) {
    return null;
  }

  const truncated = truncateText(content, maxChars);
  return {
    path: normalizedPath,
    text: truncated.text,
    truncated: truncated.truncated,
    originalLength: truncated.originalLength,
  };
}

export async function buildPlannerLongContext(task, input = {}) {
  const projectRoot = input.projectRoot ?? input.workspaceRoot ?? process.cwd();
  const workspaceSnapshot = input.workspaceSnapshot ?? [];
  const diagnostics = {
    projectRoot,
    docs: [],
    criticalFiles: [],
    totalChars: 0,
    truncated: [],
  };
  const sections = [];

  const referencedDocPaths = extractReferencedPaths(task).filter((entry) => isDocFile(entry));
  const docPaths = [...new Set([
    ...TOP_LEVEL_DOC_PRIORITY,
    ...(await listTopLevelDocs(projectRoot)),
    ...referencedDocPaths,
  ])].slice(0, MAX_FULL_DOCS);
  for (const relativePath of docPaths) {
    if (diagnostics.totalChars >= MAX_TOTAL_CHARS) {
      break;
    }

    const block = await collectFileBlock(projectRoot, relativePath, MAX_DOC_CHARS);
    if (!block) {
      continue;
    }

    diagnostics.docs.push(block.path);
    diagnostics.totalChars += block.text.length;
    if (block.truncated) {
      diagnostics.truncated.push(block.path);
    }
    sections.push(`Full top-level doc: ${block.path}\n---\n${block.text}`);
  }

  const candidateCriticalPaths = buildCandidateCriticalPaths(task, workspaceSnapshot);
  for (const relativePath of candidateCriticalPaths) {
    if (diagnostics.totalChars >= MAX_TOTAL_CHARS || diagnostics.criticalFiles.length >= MAX_CRITICAL_FILES) {
      break;
    }

    if (diagnostics.docs.includes(relativePath) || !isCodeFile(relativePath)) {
      continue;
    }

    const block = await collectFileBlock(projectRoot, relativePath, MAX_CODE_CHARS);
    if (!block) {
      continue;
    }

    diagnostics.criticalFiles.push(block.path);
    diagnostics.totalChars += block.text.length;
    if (block.truncated) {
      diagnostics.truncated.push(block.path);
    }
    sections.push(`Selected critical file: ${block.path}\n---\n${block.text}`);
  }

  return {
    text:
      sections.length > 0
        ? `Expanded planner context:\n${sections.join('\n\n')}`
        : null,
    diagnostics,
  };
}
