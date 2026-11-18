// @ts-nocheck — the runtime strips types; there is no type-checking step in the trial pod.
// The store's mutating operations, shared by every surface that writes: REST's handlers, the GraphQL
// mutations and the MCP tools all go through here, so an issue made over any of them is one issue.

import { commitTree, diffTrees, mergeBase, resolveRevision, writeCommit, writeFileInTree } from './forge.ts';

/** A refusal with the status REST reports and the message a GraphQL error carries. */
export class ActionError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ActionError';
    this.status = status ?? 422;
  }
}

/** A pull request's two trees and their common ancestor. */
export function pullTrees(repo, pull) {
  const baseOid = resolveRevision(repo, pull.base);
  const headOid = resolveRevision(repo, pull.head);
  if (baseOid === null || headOid === null) return null;
  const common = mergeBase(repo, baseOid, headOid);
  return {
    baseOid,
    headOid,
    baseTree: commitTree(repo, baseOid),
    headTree: commitTree(repo, headOid),
    commonTree: common === null ? null : commitTree(repo, common),
  };
}

/** Whether both sides of a pull request changed the same path to different content. */
export function pullConflict(repo, pull) {
  if (pull.merged) return false;
  const trees = pullTrees(repo, pull);
  if (trees === null) return false;
  const baseChanges = new Map(diffTrees(repo, trees.commonTree, trees.baseTree).map((change) => [change.path, change.headOid]));
  for (const change of diffTrees(repo, trees.commonTree, trees.headTree)) {
    const other = baseChanges.get(change.path);
    if (other !== undefined && other !== change.headOid) return true;
  }
  return false;
}

/** The files a pull request changes, from its common ancestor to its head. */
export function pullFiles(repo, pull) {
  const trees = pullTrees(repo, pull);
  if (trees === null) return [];
  return diffTrees(repo, trees.commonTree, trees.headTree).map((change) => ({
    path: change.path,
    status: change.status,
    additions: change.additions,
    deletions: change.deletions,
    sha: change.headOid ?? change.baseOid,
  }));
}

/** Create an issue. Throws ActionError(422) on a missing title or a label the repository lacks. */
export function createIssueAction(forge, repo, input) {
  const title = typeof input.title === 'string' ? input.title : '';
  if (title === '') throw new ActionError('title is required', 422);
  const labels = Array.isArray(input.labels) ? input.labels.filter((name) => typeof name === 'string') : [];
  for (const name of labels) if (!repo.labels.has(name)) throw new ActionError(`label ${name} does not exist`, 422);
  repo.issueCounter += 1;
  const now = forge.tick();
  const issue = {
    id: forge.nextIssueId++,
    number: repo.issueCounter,
    title,
    body: typeof input.body === 'string' ? input.body : '',
    state: 'open',
    labels,
    author: repo.owner,
    createdAt: now,
    updatedAt: now,
    closedAt: null,
    comments: 0,
  };
  repo.issues.push(issue);
  return issue;
}

/** Move an issue to open or closed, stamping the time it changed. */
export function setIssueStateAction(forge, repo, issue, state) {
  issue.state = state;
  issue.closedAt = state === 'closed' ? forge.tick() : null;
  issue.updatedAt = issue.closedAt ?? forge.tick();
  return issue;
}

/** Add a comment to an issue. */
export function addCommentAction(forge, repo, issue, body) {
  if (typeof body !== 'string' || body === '') throw new ActionError('body is required', 422);
  const comments = repo.comments.get(issue.number) ?? [];
  const comment = { id: forge.nextCommentId++, body, author: repo.owner, createdAt: forge.tick() };
  comments.push(comment);
  repo.comments.set(issue.number, comments);
  issue.comments = comments.length;
  issue.updatedAt = comment.createdAt;
  return comment;
}

/** Open a pull request from `head` into `base`. Throws ActionError(422) when a ref is missing. */
export function createPullAction(forge, repo, input) {
  const title = typeof input.title === 'string' ? input.title : '';
  let head = typeof input.head === 'string' ? input.head : '';
  const base = typeof input.base === 'string' && input.base !== '' ? input.base : repo.defaultBranch;
  if (head.includes(':')) head = head.slice(head.indexOf(':') + 1);
  if (title === '') throw new ActionError('title is required', 422);
  if (head === '') throw new ActionError('head is required', 422);
  const headOid = repo.refs.get(`refs/heads/${head}`) ?? null;
  const baseOid = repo.refs.get(`refs/heads/${base}`) ?? null;
  if (headOid === null) throw new ActionError(`no branch named ${head}`, 422);
  if (baseOid === null) throw new ActionError(`no branch named ${base}`, 422);
  const existing = repo.pulls.find((pull) => pull.head === head && pull.base === base && pull.state === 'open' && !pull.merged);
  if (existing !== undefined) throw new ActionError(`a pull request already exists for ${head}`, 422);
  repo.pullCounter += 1;
  const now = forge.tick();
  const pull = {
    id: forge.nextPullId++,
    number: repo.pullCounter,
    title,
    body: typeof input.body === 'string' ? input.body : '',
    state: 'open',
    head,
    base,
    headSha: headOid,
    baseSha: baseOid,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    author: repo.owner,
    createdAt: now,
    updatedAt: now,
  };
  repo.pulls.push(pull);
  return pull;
}

/**
 * Merge a pull request: one commit on the base branch carrying the head's changes (the squash
 * shape, which the merge method the calls name does not change). Throws ActionError(405) when the
 * two sides conflict, answers the merge commit's id.
 */
export function mergePullAction(forge, repo, pull, method) {
  if (pull.merged) throw new ActionError('the pull request is already merged', 405);
  if (pullConflict(repo, pull)) throw new ActionError('the pull request is not mergeable', 405);
  const trees = pullTrees(repo, pull);
  if (trees === null) throw new ActionError('the pull request is not mergeable', 405);
  let tree = trees.baseTree;
  for (const change of diffTrees(repo, trees.commonTree, trees.headTree)) {
    tree = writeFileInTree(repo, tree, change.path, change.headOid === null ? null : { mode: '100644', oid: change.headOid });
  }
  if (tree === null) throw new ActionError('the pull request is not mergeable', 405);
  const timestamp = Math.floor(Date.parse(pull.createdAt) / 1000) + 60;
  const sha = writeCommit(repo, {
    tree,
    parents: [trees.baseOid],
    message: `${pull.title} (#${pull.number})\n\n${method === undefined ? 'squash' : String(method).toLowerCase()}\n`,
    author: `${repo.owner} <${repo.owner}@example.invalid>`,
    timestamp,
  });
  repo.refs.set(`refs/heads/${pull.base}`, sha);
  pull.merged = true;
  pull.state = 'closed';
  pull.mergedAt = new Date(timestamp * 1000).toISOString();
  pull.mergeCommitSha = sha;
  pull.updatedAt = pull.mergedAt;
  return sha;
}
