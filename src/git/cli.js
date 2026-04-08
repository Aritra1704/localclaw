import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { config } from '../config.js';

const execFileAsync = promisify(execFile);

function buildGitHubPushHeader(token) {
  const credentials = Buffer.from(`x-access-token:${token}`).toString('base64');
  return `AUTHORIZATION: basic ${credentials}`;
}

async function runGit(args, options = {}) {
  const result = await execFileAsync('git', args, {
    cwd: options.cwd,
    env: {
      ...process.env,
      ...(options.env ?? {}),
    },
    maxBuffer: options.maxBuffer ?? 10 * 1024 * 1024,
  });

  return {
    stdout: result.stdout?.trim() ?? '',
    stderr: result.stderr?.trim() ?? '',
  };
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function ensureLocalIdentity(cwd, options = {}) {
  const nameFallback = options.name ?? 'LocalClaw';
  const emailFallback =
    options.email ??
    (config.githubUsername
      ? `${config.githubUsername}@users.noreply.github.com`
      : 'localclaw@users.noreply.github.com');

  const currentName = await runGit(['config', '--get', 'user.name'], { cwd }).catch(
    () => ({ stdout: '' })
  );
  const currentEmail = await runGit(['config', '--get', 'user.email'], { cwd }).catch(
    () => ({ stdout: '' })
  );

  if (!currentName.stdout) {
    await runGit(['config', 'user.name', nameFallback], { cwd });
  }

  if (!currentEmail.stdout) {
    await runGit(['config', 'user.email', emailFallback], { cwd });
  }
}

export function createGitClient(options = {}) {
  const defaultBranch = options.defaultBranch ?? config.gitDefaultBranch;

  return {
    async initRepository(cwd) {
      const gitDir = path.join(cwd, '.git');
      if (!(await pathExists(gitDir))) {
        await runGit(['init'], { cwd });
      }

      await runGit(['branch', '-M', defaultBranch], { cwd });
      await ensureLocalIdentity(cwd, options.identity);
    },

    async addAll(cwd) {
      await runGit(['add', '.'], { cwd });
    },

    async hasStagedOrWorkingChanges(cwd) {
      const result = await runGit(['status', '--porcelain'], { cwd });
      return result.stdout.length > 0;
    },

    async commitAll(cwd, message) {
      await this.addAll(cwd);

      if (!(await this.hasStagedOrWorkingChanges(cwd))) {
        const shaResult = await runGit(['rev-parse', 'HEAD'], { cwd }).catch(() => ({
          stdout: '',
        }));
        return {
          createdCommit: false,
          commitSha: shaResult.stdout || null,
        };
      }

      await runGit(['commit', '-m', message], { cwd });
      const shaResult = await runGit(['rev-parse', 'HEAD'], { cwd });

      return {
        createdCommit: true,
        commitSha: shaResult.stdout,
      };
    },

    async ensureRemote(cwd, name, url) {
      const currentRemote = await runGit(['remote', 'get-url', name], { cwd }).catch(
        () => ({ stdout: '' })
      );

      if (!currentRemote.stdout) {
        await runGit(['remote', 'add', name, url], { cwd });
        return;
      }

      if (currentRemote.stdout !== url) {
        await runGit(['remote', 'set-url', name, url], { cwd });
      }
    },

    async pushBranch(cwd, options) {
      const { remoteName = 'origin', branch = defaultBranch, token } = options;
      const args = ['push', '-u', remoteName, branch];

      if (!token) {
        await runGit(args, { cwd });
        return;
      }

      const header = buildGitHubPushHeader(token);
      await runGit(
        ['-c', `http.https://github.com/.extraheader=${header}`, ...args],
        { cwd }
      );
    },
  };
}
