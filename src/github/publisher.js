import { config } from '../config.js';

function sanitizeRepositoryName(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function buildRepositoryDescription(task) {
  return task.description.replace(/\s+/g, ' ').trim().slice(0, 160);
}

function deriveRepositoryName(task, context) {
  return sanitizeRepositoryName(
    task.project_name ?? task.title ?? context.workspaceName
  );
}

export function createGitHubPublisher({ gitClient, githubClient, logger }) {
  return {
    isEnabled() {
      return (
        config.githubAutoPublish &&
        Boolean(config.githubPat) &&
        Boolean(config.githubRepoOwner || config.githubUsername)
      );
    },

    async publishWorkspace(task, context) {
      const owner = config.githubRepoOwner || config.githubUsername;
      if (!owner) {
        throw new Error('GITHUB_REPO_OWNER or GITHUB_USERNAME is required for publish');
      }

      const repositoryName = deriveRepositoryName(task, context);

      if (!repositoryName) {
        throw new Error('Unable to derive a valid GitHub repository name for this task');
      }

      const repository = await githubClient.ensureRepository({
        owner,
        name: repositoryName,
        description: buildRepositoryDescription(task),
        private: config.githubRepoVisibility !== 'public',
      });
      const publishBranch = repository.default_branch || config.gitDefaultBranch;

      await gitClient.initRepository(context.workspaceRoot, {
        branch: publishBranch,
      });
      await gitClient.ensureRemote(context.workspaceRoot, 'origin', repository.clone_url);

      const commitResult = await gitClient.commitAll(
        context.workspaceRoot,
        `feat: bootstrap ${repositoryName} via localclaw`
      );

      await gitClient.pushBranch(context.workspaceRoot, {
        remoteName: 'origin',
        branch: publishBranch,
        token: config.githubPat,
      });

      logger?.info(
        {
          taskId: task.id,
          repositoryName,
          repositoryUrl: repository.html_url,
        },
        'Published workspace to GitHub'
      );

      return {
        attempted: true,
        published: true,
        repo: {
          owner,
          name: repository.name,
          htmlUrl: repository.html_url,
          cloneUrl: repository.clone_url,
          defaultBranch: publishBranch,
        },
        commit: {
          sha: commitResult.commitSha,
          created: commitResult.createdCommit,
        },
      };
    },
  };
}
