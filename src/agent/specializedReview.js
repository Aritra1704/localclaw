import fs from 'node:fs/promises';
import path from 'node:path';

import { shouldIgnoreWorkspaceEntry } from '../project/contract.js';
import { collectWorkspaceSnapshot } from '../tools/registry.js';

const README_AUTODOC_MARKER = 'localclaw:autodoc:readme';
const ARCHITECTURE_AUTODOC_MARKER = 'localclaw:autodoc:architecture';

const CODE_FILE_PATTERN =
  /\.(cjs|cts|go|java|js|json|jsx|mjs|mts|py|rb|rs|sh|sql|ts|tsx|yaml|yml)$/i;

const TEXT_FILE_PATTERN =
  /\.(cjs|conf|css|env|gitignore|html|java|js|json|jsx|md|mjs|py|rb|rs|sh|sql|svg|toml|ts|tsx|txt|xml|yaml|yml)$/i;

const SECRET_PATTERNS = [
  {
    label: 'OpenAI API key',
    severity: 'high',
    pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    label: 'GitHub personal access token',
    severity: 'high',
    pattern: /\b(?:ghp|github_pat)_[A-Za-z0-9_]{20,}\b/g,
  },
  {
    label: 'AWS access key',
    severity: 'high',
    pattern: /\bAKIA[0-9A-Z]{16}\b/g,
  },
  {
    label: 'Private key block',
    severity: 'high',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
  },
  {
    label: 'Slack webhook URL',
    severity: 'high',
    pattern: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+/g,
  },
];

const RISKY_PATTERNS = [
  {
    label: 'curl pipe shell',
    severity: 'medium',
    pattern: /\bcurl\b[^\n|]*\|\s*(?:sh|bash)\b/g,
  },
  {
    label: 'wget pipe shell',
    severity: 'medium',
    pattern: /\bwget\b[^\n|]*\|\s*(?:sh|bash)\b/g,
  },
  {
    label: 'world-writable permissions',
    severity: 'medium',
    pattern: /\bchmod\s+777\b/g,
  },
  {
    label: 'destructive root delete',
    severity: 'medium',
    pattern: /\brm\s+-rf\s+\/(?![A-Za-z0-9._-])/g,
  },
];

const VULNERABLE_NODE_PACKAGES = {
  axios: '1.8.2',
  'body-parser': '1.20.3',
  braces: '3.0.3',
  cookie: '0.7.0',
  ejs: '3.1.10',
  express: '4.20.0',
  jsonwebtoken: '9.0.2',
  lodash: '4.17.21',
  minimist: '1.2.8',
  nanoid: '3.3.8',
  qs: '6.13.0',
  'node-fetch': '2.7.0',
};

function normalizePath(value) {
  return `${value ?? ''}`.replace(/\\/g, '/');
}

function isManagedWorkspaceFile(relativePath) {
  const normalized = normalizePath(relativePath);
  return (
    normalized === 'README.md' ||
    normalized === 'docs/ARCHITECTURE.md' ||
    normalized === 'TASK.md' ||
    normalized === 'PROJECT_CONTEXT.md' ||
    normalized === 'PROJECT_CONTEXT.local.md' ||
    normalized === 'PROJECT_RULES.md' ||
    normalized.startsWith('.opskit/')
  );
}

function isCodeWorkspaceFile(relativePath) {
  const normalized = normalizePath(relativePath);
  if (isManagedWorkspaceFile(normalized)) {
    return false;
  }

  return CODE_FILE_PATTERN.test(normalized);
}

function isTextWorkspaceFile(relativePath) {
  const normalized = normalizePath(relativePath);
  if (normalized.startsWith('.git/')) {
    return false;
  }

  return TEXT_FILE_PATTERN.test(normalized) || path.basename(normalized) === 'Dockerfile';
}

function sortPaths(values) {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function semverParts(version) {
  const cleaned = `${version ?? ''}`
    .trim()
    .replace(/^[^0-9]*/, '')
    .match(/\d+/g);

  if (!cleaned || cleaned.length === 0) {
    return null;
  }

  return cleaned.slice(0, 3).map((item) => Number.parseInt(item, 10) || 0);
}

function compareSemver(left, right) {
  const leftParts = semverParts(left);
  const rightParts = semverParts(right);
  if (!leftParts || !rightParts) {
    return null;
  }

  const maxLength = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < maxLength; index += 1) {
    const leftValue = leftParts[index] ?? 0;
    const rightValue = rightParts[index] ?? 0;
    if (leftValue > rightValue) {
      return 1;
    }
    if (leftValue < rightValue) {
      return -1;
    }
  }

  return 0;
}

function stripMarkdown(text) {
  return `${text ?? ''}`
    .replace(/\r/g, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/`([^`]+)`/g, '$1')
    .trim();
}

function upsertManagedSection(existingContent, marker, sectionTitle, body) {
  const block = [
    `<!-- ${marker}:start -->`,
    `## ${sectionTitle}`,
    '',
    body.trim(),
    `<!-- ${marker}:end -->`,
    '',
  ].join('\n');

  const escapedMarker = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    `<!-- ${escapedMarker}:start -->[\\s\\S]*?<!-- ${escapedMarker}:end -->\\n?`,
    'm'
  );

  if (pattern.test(existingContent)) {
    return existingContent.replace(pattern, block);
  }

  const trimmed = existingContent.trim();
  if (trimmed.length === 0) {
    return `${block}`;
  }

  return `${existingContent.replace(/\s*$/, '\n\n')}${block}`;
}

function summarizePackageScripts(packageJson) {
  const entries = Object.entries(packageJson?.scripts ?? {}).slice(0, 6);
  if (entries.length === 0) {
    return '- no scripts declared';
  }

  return entries.map(([name, command]) => `- \`npm run ${name}\` -> ${command}`).join('\n');
}

function summarizeDependencies(packageJson) {
  const dependencyGroups = [
    ...Object.entries(packageJson?.dependencies ?? {}),
    ...Object.entries(packageJson?.devDependencies ?? {}),
  ];

  if (dependencyGroups.length === 0) {
    return '- no Node dependencies declared';
  }

  return dependencyGroups
    .slice(0, 8)
    .map(([name, version]) => `- \`${name}\`: ${version}`)
    .join('\n');
}

function buildReadmeAutodoc(task, workspaceFiles, packageJson) {
  const codeFiles = sortPaths(workspaceFiles.filter(isCodeWorkspaceFile)).slice(0, 12);
  const runtimeFiles = sortPaths(
    workspaceFiles.filter((filePath) =>
      /(?:^|\/)(package\.json|Dockerfile|docker-compose\.ya?ml|railway\.json|vite\.config\.[cm]?js|tsconfig\.json)$/i.test(
        filePath
      )
    )
  );

  return [
    `Generated from the current workspace for task \`${task.id}\`.`,
    '',
    '### Scope',
    '',
    stripMarkdown(task.description),
    '',
    '### Key Files',
    '',
    codeFiles.length > 0
      ? codeFiles.map((filePath) => `- \`${filePath}\``).join('\n')
      : '- no application source files detected',
    '',
    '### Runtime Files',
    '',
    runtimeFiles.length > 0
      ? runtimeFiles.map((filePath) => `- \`${filePath}\``).join('\n')
      : '- no runtime manifests detected',
    '',
    '### Scripts',
    '',
    summarizePackageScripts(packageJson),
    '',
    '### Dependencies',
    '',
    summarizeDependencies(packageJson),
  ].join('\n');
}

function buildArchitectureAutodoc(task, workspaceFiles, packageJson) {
  const sourceFiles = sortPaths(workspaceFiles.filter(isCodeWorkspaceFile)).slice(0, 20);
  const topLevelDirectories = sortPaths(
    workspaceFiles
      .filter((filePath) => filePath.includes('/'))
      .map((filePath) => filePath.split('/')[0])
      .filter((segment) => segment !== 'docs' && segment !== '.opskit')
  ).filter((segment, index, values) => values.indexOf(segment) === index);

  return [
    `Auto-maintained architecture snapshot for task \`${task.id}\`.`,
    '',
    '### Task Intent',
    '',
    stripMarkdown(task.description),
    '',
    '### Top-Level Modules',
    '',
    topLevelDirectories.length > 0
      ? topLevelDirectories.map((segment) => `- \`${segment}/\``).join('\n')
      : '- workspace is currently flat',
    '',
    '### Notable Source Files',
    '',
    sourceFiles.length > 0
      ? sourceFiles.map((filePath) => `- \`${filePath}\``).join('\n')
      : '- no code-oriented files detected',
    '',
    '### Node Entry Points',
    '',
    packageJson?.main
      ? `- \`${packageJson.main}\``
      : packageJson?.scripts?.start
        ? `- start script: \`${packageJson.scripts.start}\``
        : '- no explicit entry point declared',
  ].join('\n');
}

async function safeReadFile(targetPath) {
  try {
    return await fs.readFile(targetPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return '';
    }
    throw error;
  }
}

async function writeManagedMarkdown(targetPath, marker, title, body) {
  const existingContent = await safeReadFile(targetPath);
  const nextContent = upsertManagedSection(existingContent, marker, title, body);

  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, nextContent, 'utf8');

  return {
    changed: existingContent !== nextContent,
    bytesWritten: Buffer.byteLength(nextContent, 'utf8'),
  };
}

async function loadPackageJson(workspaceRoot) {
  const packageJsonPath = path.join(workspaceRoot, 'package.json');
  const raw = await safeReadFile(packageJsonPath);
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function loadWorkspaceTextFiles(workspaceRoot, workspaceFiles) {
  const records = [];

  for (const relativePath of workspaceFiles) {
    if (!isTextWorkspaceFile(relativePath) || shouldIgnoreWorkspaceEntry(relativePath)) {
      continue;
    }

    const absolutePath = path.join(workspaceRoot, relativePath);
    const stats = await fs.stat(absolutePath).catch(() => null);
    if (!stats || !stats.isFile() || stats.size > 512_000) {
      continue;
    }

    const content = await fs.readFile(absolutePath, 'utf8').catch(() => null);
    if (content === null) {
      continue;
    }

    records.push({
      relativePath,
      content,
    });
  }

  return records;
}

function collectPatternFindings(files, patternDefinitions) {
  const findings = [];

  for (const file of files) {
    for (const definition of patternDefinitions) {
      const matches = [...file.content.matchAll(definition.pattern)];
      if (matches.length === 0) {
        continue;
      }

      findings.push({
        severity: definition.severity,
        type: definition.label,
        path: file.relativePath,
        sample: `${matches[0][0]}`.slice(0, 80),
      });
    }
  }

  return findings;
}

function extractDeclaredDependencies(packageJson) {
  return [
    ...Object.entries(packageJson?.dependencies ?? {}).map(([name, version]) => ({
      scope: 'dependencies',
      name,
      version,
    })),
    ...Object.entries(packageJson?.devDependencies ?? {}).map(([name, version]) => ({
      scope: 'devDependencies',
      name,
      version,
    })),
  ];
}

function buildFollowUpTitle(projectName, dependencyName) {
  return `Patch dependency ${dependencyName} for ${projectName}`;
}

function buildFollowUpDescription(task, projectName, dependencyName, currentVersion, targetVersion) {
  return [
    `Patch dependency \`${dependencyName}\` in project \`${projectName}\`.`,
    '',
    `Originating task: ${task.title}`,
    `Current declared version: ${currentVersion}`,
    `Target minimum safe version: ${targetVersion}`,
    '',
    'Reason:',
    '- Phase 10 Dependency Agent found a package below the curated minimum safe version.',
    '- Update the manifest and lockfile, run the project verification path, and summarize the upgrade impact.',
  ].join('\n');
}

function aggregateStatus(statuses) {
  if (statuses.includes('failed')) {
    return 'failed';
  }
  if (statuses.includes('needs_human_review')) {
    return 'needs_human_review';
  }
  return 'passed';
}

export function createSpecializedReviewService({ logger } = {}) {
  return {
    async reviewTask(task, context) {
      const workspaceRoot = context.workspaceRoot;
      const packageJson = await loadPackageJson(workspaceRoot);
      const initialSnapshot = await collectWorkspaceSnapshot(workspaceRoot, {
        recursive: true,
        limit: 200,
      });
      const initialPaths = initialSnapshot.map((entry) => entry.path);
      const hasMaterialWorkspaceFiles = initialPaths.some((filePath) => !isManagedWorkspaceFile(filePath));

      const agents = [];
      const artifacts = [];
      const followUpTasks = [];

      if (hasMaterialWorkspaceFiles) {
        const readmeResult = await writeManagedMarkdown(
          path.join(workspaceRoot, 'README.md'),
          README_AUTODOC_MARKER,
          'Autodoc Summary',
          buildReadmeAutodoc(task, initialPaths, packageJson)
        );
        const architectureResult = await writeManagedMarkdown(
          path.join(workspaceRoot, 'docs', 'ARCHITECTURE.md'),
          ARCHITECTURE_AUTODOC_MARKER,
          'Autodoc Architecture',
          buildArchitectureAutodoc(task, initialPaths, packageJson)
        );

        if (readmeResult.changed) {
          artifacts.push({
            artifactType: 'file',
            artifactPath: path.join(workspaceRoot, 'README.md'),
            metadata: {
              relativePath: 'README.md',
              bytesWritten: readmeResult.bytesWritten,
              source: 'documentation_agent',
            },
          });
        }

        if (architectureResult.changed) {
          artifacts.push({
            artifactType: 'file',
            artifactPath: path.join(workspaceRoot, 'docs', 'ARCHITECTURE.md'),
            metadata: {
              relativePath: 'docs/ARCHITECTURE.md',
              bytesWritten: architectureResult.bytesWritten,
              source: 'documentation_agent',
            },
          });
        }

        agents.push({
          name: 'documentation',
          status: 'passed',
          summary:
            readmeResult.changed || architectureResult.changed
              ? 'Documentation Agent refreshed README and architecture notes from the current workspace.'
              : 'Documentation Agent confirmed the managed README and architecture sections are current.',
          updatedFiles: ['README.md', 'docs/ARCHITECTURE.md'],
          findings: [],
        });
      } else {
        agents.push({
          name: 'documentation',
          status: 'passed',
          summary: 'Documentation Agent skipped autopatching because the workspace has no material source files yet.',
          updatedFiles: [],
          findings: [],
        });
      }

      const refreshedSnapshot = await collectWorkspaceSnapshot(workspaceRoot, {
        recursive: true,
        limit: 220,
      });
      const refreshedPaths = refreshedSnapshot.map((entry) => entry.path);
      const textFiles = await loadWorkspaceTextFiles(workspaceRoot, refreshedPaths);
      const secretFindings = collectPatternFindings(textFiles, SECRET_PATTERNS);
      const riskyFindings = collectPatternFindings(textFiles, RISKY_PATTERNS);
      const securityStatus =
        secretFindings.length > 0
          ? 'failed'
          : riskyFindings.length > 0
            ? 'needs_human_review'
            : 'passed';

      agents.push({
        name: 'security',
        status: securityStatus,
        summary:
          securityStatus === 'failed'
            ? `Security Review Agent found ${secretFindings.length} high-risk secret or credential pattern(s).`
            : securityStatus === 'needs_human_review'
              ? `Security Review Agent found ${riskyFindings.length} risky command or permission pattern(s).`
              : 'Security Review Agent found no high-confidence secret or risky shell patterns.',
        findings: [...secretFindings, ...riskyFindings],
        updatedFiles: [],
      });

      const dependencyFindings = [];
      if (packageJson) {
        for (const dependency of extractDeclaredDependencies(packageJson)) {
          const targetVersion = VULNERABLE_NODE_PACKAGES[dependency.name];
          if (!targetVersion) {
            continue;
          }

          const comparison = compareSemver(dependency.version, targetVersion);
          if (comparison === null || comparison >= 0) {
            continue;
          }

          dependencyFindings.push({
            severity: 'high',
            dependency: dependency.name,
            currentVersion: dependency.version,
            targetVersion,
            scope: dependency.scope,
          });
        }

        const hasLockfile = refreshedPaths.some((filePath) =>
          /(?:^|\/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock)$/i.test(
            filePath
          )
        );

        if (
          extractDeclaredDependencies(packageJson).length > 0 &&
          !hasLockfile
        ) {
          dependencyFindings.push({
            severity: 'medium',
            dependency: 'lockfile',
            currentVersion: 'missing',
            targetVersion: 'commit a lockfile',
            scope: 'repository',
          });
        }
      }

      for (const finding of dependencyFindings.filter((item) => item.dependency !== 'lockfile')) {
        const projectName =
          task.project_name ??
          packageJson?.name ??
          context.workspaceName ??
          'workspace';
        followUpTasks.push({
          title: buildFollowUpTitle(projectName, finding.dependency),
          description: buildFollowUpDescription(
            task,
            projectName,
            finding.dependency,
            finding.currentVersion,
            finding.targetVersion
          ),
          priority: 'high',
          source: 'phase10_dependency_agent',
          projectName: task.project_name ?? projectName,
          projectPath: workspaceRoot,
          metadata: {
            dependency: finding.dependency,
            currentVersion: finding.currentVersion,
            targetVersion: finding.targetVersion,
            sourceTaskId: task.id,
          },
        });
      }

      const dependencyStatus =
        dependencyFindings.some((item) => item.severity === 'high')
          ? 'needs_human_review'
          : dependencyFindings.length > 0
            ? 'needs_human_review'
            : 'passed';

      agents.push({
        name: 'dependency',
        status: dependencyStatus,
        summary:
          dependencyFindings.length > 0
            ? `Dependency Agent found ${dependencyFindings.length} dependency maintenance issue(s).`
            : 'Dependency Agent found no curated dependency maintenance issues.',
        findings: dependencyFindings,
        updatedFiles: [],
      });

      const status = aggregateStatus(agents.map((agent) => agent.status));
      const summary =
        status === 'passed'
          ? 'Specialized agents passed documentation, security, and dependency review.'
          : status === 'failed'
            ? 'Specialized agents blocked finalization due to high-risk security findings.'
            : 'Specialized agents require operator review before publishing.';

      logger?.info?.(
        {
          taskId: task.id,
          status,
          followUpTaskCount: followUpTasks.length,
        },
        'Specialized review completed'
      );

      return {
        status,
        summary,
        agents,
        artifacts,
        followUpTasks,
      };
    },
  };
}
