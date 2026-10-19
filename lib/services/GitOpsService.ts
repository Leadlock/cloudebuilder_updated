import { Octokit } from '@octokit/rest';
import { db } from '../../src/prisma/db';

export class GitOpsService {
  /**
   * Commits generated Terraform code to a GitHub repository and optionally creates a PR.
   */
  static async commitArchitecture(params: {
    projectId: string;
    githubOrg: string;
    githubRepo: string;
    branch: string;
    commitMessage: string;
    files: { path: string, content: string }[];
    createPullRequest: boolean;
    githubToken: string; // From OAuth connection
  }) {
    const octokit = new Octokit({ auth: params.githubToken });
    const { githubOrg, githubRepo, branch, files } = params;

    // Get current commit of the branch
    const { data: refData } = await octokit.git.getRef({
      owner: githubOrg,
      repo: githubRepo,
      ref: `heads/${branch}`
    });
    const commitSha = refData.object.sha;

    const { data: commitData } = await octokit.git.getCommit({
      owner: githubOrg,
      repo: githubRepo,
      commit_sha: commitSha
    });
    const treeSha = commitData.tree.sha;

    // Create tree for new files
    const tree = files.map(file => ({
      path: file.path,
      mode: '100644' as const,
      type: 'blob' as const,
      content: file.content
    }));

    const { data: newTree } = await octokit.git.createTree({
      owner: githubOrg,
      repo: githubRepo,
      tree,
      base_tree: treeSha
    });

    // Create commit
    const { data: newCommit } = await octokit.git.createCommit({
      owner: githubOrg,
      repo: githubRepo,
      message: params.commitMessage,
      tree: newTree.sha,
      parents: [commitSha]
    });

    // Update ref
    const targetBranch = params.createPullRequest ? `cloudbuilder-${Date.now()}` : branch;
    
    if (params.createPullRequest) {
      // Create new branch
      await octokit.git.createRef({
        owner: githubOrg,
        repo: githubRepo,
        ref: `refs/heads/${targetBranch}`,
        sha: newCommit.sha
      });

      // Create PR
      const { data: pr } = await octokit.pulls.create({
        owner: githubOrg,
        repo: githubRepo,
        title: params.commitMessage,
        head: targetBranch,
        base: branch
      });

      // The GitHub operation already succeeded at this point — a DB logging
      // failure must not surface as an error for a commit/PR that actually went through.
      try {
        await db.orm.public.GitOperation.create({
            id: crypto.randomUUID(),
            projectId: params.projectId,
            commitSha: newCommit.sha,
            prUrl: pr.html_url,
            status: 'success',
            operationType: 'pull_request',
            createdAt: new Date().toISOString()
        });
      } catch (err) {
        console.warn('[GitOpsService] Failed to record git operation history:', (err as Error)?.message);
      }

      return { prUrl: pr.html_url, commitSha: newCommit.sha };
    } else {
      // Direct commit
      await octokit.git.updateRef({
        owner: githubOrg,
        repo: githubRepo,
        ref: `heads/${branch}`,
        sha: newCommit.sha
      });

      try {
        await db.orm.public.GitOperation.create({
            id: crypto.randomUUID(),
            projectId: params.projectId,
            commitSha: newCommit.sha,
            status: 'success',
            operationType: 'commit',
            createdAt: new Date().toISOString()
        });
      } catch (err) {
        console.warn('[GitOpsService] Failed to record git operation history:', (err as Error)?.message);
      }

      return { commitSha: newCommit.sha };
    }
  }
}
