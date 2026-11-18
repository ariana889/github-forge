// @ts-nocheck — the runtime strips types; there is no type-checking step in the trial pod.
// The REST v3 surface: repositories, branches, commits, the Git Data refs, the contents API, labels,
// issues, comments and pull requests with their files and their merge. Every reply is JSON and
// carries an X-GitHub-Request-Id; a repository belongs to the login that owns it, so a name under
// another owner is a 404 and never a 403.

import {
  commitLog,
  commitTree,
  diffTrees,
  flattenTree,
  getBlob,
  getCommit,
  isAncestor,
  lineDelta,
  mergeBase,
  pathEntry,
  putObject,
  refTip,
  resolveRevision,
  treeEntries,
  writeCommit,
  writeFileInTree,
  ZERO_OID,
} from './forge.ts';
import {
  ActionError,
  addCommentAction,
  createIssueAction,
  createPullAction,
  mergePullAction,
  pullConflict,
  pullFiles as pullChanges,
  setIssueStateAction,
} from './actions.ts';
import { readJson, sendEmpty, sendJson } from './http.ts';

/** The scopes the API root reports. */
const SCOPES = 'repo, read:org';
/** The version the meta route reports. */
const INSTALLED_VERSION = 'makefun-forge-1.0.0';

// ---------------------------------------------------------------- views

/** A user as REST shows it. */
export function userView(login) {
  return {
    login,
    id: 1000,
    node_id: Buffer.from(`User:${login}`).toString('base64'),
    avatar_url: `https://avatars.example.invalid/u/${login}`,
    gravatar_id: '',
    url: `/api/v3/users/${login}`,
    html_url: `https://forge.example.invalid/${login}`,
    type: 'User',
    site_admin: false,
  };
}

/** A repository as REST shows it. */
export function repoView(repo) {
  return {
    id: repo.id,
    node_id: Buffer.from(`Repository:${repo.id}`).toString('base64'),
    name: repo.name,
    full_name: repo.fullName,
    owner: userView(repo.owner),
    private: repo.private,
    description: repo.description,
    fork: false,
    url: `/api/v3/repos/${repo.fullName}`,
    html_url: `https://forge.example.invalid/${repo.fullName}`,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.createdAt,
    pushed_at: repo.createdAt,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    open_issues_count: repo.issues.filter((issue) => issue.state === 'open').length,
    size: 0,
    language: null,
    archived: false,
    disabled: false,
    visibility: repo.private ? 'private' : 'public',
  };
}

/** A label as REST shows it. */
export function labelView(repo, name) {
  const color = repo.labels.get(name) ?? 'ededed';
  return { id: 1, node_id: Buffer.from(`Label:${repo.id}:${name}`).toString('base64'), name, color, default: false, description: null, url: `/api/v3/repos/${repo.fullName}/labels/${name}` };
}

/** An issue as REST shows it. */
export function issueView(repo, issue) {
  return {
    id: issue.id,
    node_id: Buffer.from(`Issue:${repo.id}:${issue.number}`).toString('base64'),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    state_reason: issue.state === 'closed' ? 'completed' : null,
    locked: false,
    user: userView(issue.author),
    labels: issue.labels.map((name) => labelView(repo, name)),
    assignee: null,
    assignees: [],
    milestone: null,
    comments: issue.comments,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    url: `/api/v3/repos/${repo.fullName}/issues/${issue.number}`,
    html_url: `https://forge.example.invalid/${repo.fullName}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.fullName}`,
    comments_url: `/api/v3/repos/${repo.fullName}/issues/${issue.number}/comments`,
    labels_url: `/api/v3/repos/${repo.fullName}/issues/${issue.number}/labels`,
  };
}

/** A comment as REST shows it. */
export function commentView(repo, issue, comment) {
  return {
    id: comment.id,
    node_id: Buffer.from(`IssueComment:${comment.id}`).toString('base64'),
    body: comment.body,
    user: userView(comment.author),
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
    url: `/api/v3/repos/${repo.fullName}/issues/comments/${comment.id}`,
    html_url: `https://forge.example.invalid/${repo.fullName}/issues/${issue.number}#issuecomment-${comment.id}`,
    issue_url: `/api/v3/repos/${repo.fullName}/issues/${issue.number}`,
  };
}

/** A pull request as REST shows it. */
export function pullView(repo, pull) {
  const headSha = refTip(repo, `refs/heads/${pull.head}`) ?? pull.headSha;
  const baseSha = refTip(repo, `refs/heads/${pull.base}`) ?? pull.baseSha;
  return {
    id: pull.id,
    node_id: Buffer.from(`PullRequest:${repo.id}:${pull.number}`).toString('base64'),
    number: pull.number,
    state: pull.merged ? 'closed' : pull.state,
    title: pull.title,
    body: pull.body,
    user: userView(pull.author),
    labels: [],
    draft: false,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: pullConflict(repo, pull) ? 'CONFLICTING' : 'MERGEABLE',
    mergeable_state: pull.merged ? 'unknown' : 'clean',
    head: { label: `${repo.owner}:${pull.head}`, ref: pull.head, sha: headSha, user: userView(repo.owner) },
    base: { label: `${repo.owner}:${pull.base}`, ref: pull.base, sha: baseSha, user: userView(repo.owner) },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.merged ? pull.mergedAt : null,
    url: `/api/v3/repos/${repo.fullName}/pulls/${pull.number}`,
    html_url: `https://forge.example.invalid/${repo.fullName}/pull/${pull.number}`,
    commits_url: `/api/v3/repos/${repo.fullName}/pulls/${pull.number}/commits`,
    files_url: `/api/v3/repos/${repo.fullName}/pulls/${pull.number}/files`,
  };
}

// ---------------------------------------------------------------- pull request arithmetic

/** A pull request's changed files, as the files route reports them. */
export function pullFiles(repo, pull) {
  return pullChanges(repo, pull).map((change) => ({
    sha: change.sha,
    filename: change.path,
    status: change.status,
    additions: change.additions,
    deletions: change.deletions,
    changes: change.additions + change.deletions,
    blob_url: `/api/v3/repos/${repo.fullName}/blob/${pull.head}/${change.path}`,
    raw_url: `/api/v3/repos/${repo.fullName}/raw/${pull.head}/${change.path}`,
    contents_url: `/api/v3/repos/${repo.fullName}/contents/${change.path}?ref=${pull.head}`,
  }));
}

// ---------------------------------------------------------------- request helpers

function apiError(res, status, message, extra) {
  sendJson(res, status, { message, documentation_url: 'https://docs.github.com/rest', ...(extra ?? {}) });
}

function objectBody(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : null;
}

function pageOf(query, fallback) {
  const raw = Number.parseInt(query.get('per_page') ?? '', 10);
  const value = Number.isFinite(raw) && raw > 0 ? Math.min(100, raw) : fallback;
  return value;
}

function pageNumber(query) {
  const raw = Number.parseInt(query.get('page') ?? '1', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 1;
}

/** The absolute base URL of this server, from the request's Host header. */
function originOf(req) {
  const host = req.headers.host;
  return typeof host === 'string' && host !== '' ? `http://${host}` : 'http://127.0.0.1';
}

/** A paginated JSON array reply, with GitHub's Link header when another page exists. */
function sendPage(req, res, items, query, path) {
  const perPage = pageOf(query, 30);
  const page = pageNumber(query);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const headers = {};
  if (start + perPage < items.length) {
    const url = new URL(`${originOf(req)}${path}`);
    url.searchParams.set('per_page', String(perPage));
    url.searchParams.set('page', String(page + 1));
    headers.link = `<${url.toString()}>; rel="next"`;
  }
  sendJson(res, 200, slice, headers);
}

// ---------------------------------------------------------------- contents

/** The tree a `ref` query names, defaulting to the repository's default branch. */
function treeForRef(repo, ref) {
  const revision = ref === null || ref === '' ? repo.defaultBranch : ref;
  const oid = resolveRevision(repo, revision);
  if (oid === null) return null;
  return commitTree(repo, oid);
}

/** One directory listing for the contents API. */
function directoryListing(repo, treeOid, prefix) {
  return treeEntries(repo, treeOid).map((entry) => {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    const isDir = entry.mode === '40000';
    const size = isDir ? 0 : (getBlob(repo, entry.oid) ?? Buffer.alloc(0)).length;
    return {
      type: isDir ? 'dir' : 'file',
      name: entry.name,
      path,
      sha: entry.oid,
      size,
      url: `/api/v3/repos/${repo.fullName}/contents/${path}`,
      html_url: `https://forge.example.invalid/${repo.fullName}/blob/HEAD/${path}`,
      download_url: isDir ? null : `/api/v3/repos/${repo.fullName}/raw/HEAD/${path}`,
    };
  });
}

/** One file's contents body. */
function fileView(repo, path, oid) {
  const data = getBlob(repo, oid) ?? Buffer.alloc(0);
  return {
    type: 'file',
    encoding: 'base64',
    size: data.length,
    name: path.split('/').pop(),
    path,
    sha: oid,
    content: data.toString('base64'),
    url: `/api/v3/repos/${repo.fullName}/contents/${path}`,
    html_url: `https://forge.example.invalid/${repo.fullName}/blob/HEAD/${path}`,
    download_url: `/api/v3/repos/${repo.fullName}/raw/HEAD/${path}`,
    git_url: `/api/v3/repos/${repo.fullName}/git/blobs/${oid}`,
  };
}

/** Write one commit that sets (or removes) one path, and move the branch to it. */
function commitPath(forge, repo, { branch, path, blobOid, message }) {
  const refName = `refs/heads/${branch}`;
  const parent = refTip(repo, refName);
  const parentTree = parent === null ? null : commitTree(repo, parent);
  const tree = writeFileInTree(repo, parentTree, path, blobOid === null ? null : { mode: '100644', oid: blobOid });
  const timestamp = Math.floor(Date.parse(forge.tick()) / 1000);
  const commitOid = writeCommit(repo, {
    tree: tree ?? putObject(repo, 'tree', Buffer.alloc(0)),
    parents: parent === null ? [] : [parent],
    message: message.endsWith('\n') ? message : `${message}\n`,
    author: `${repo.owner} <${repo.owner}@example.invalid>`,
    timestamp,
  });
  repo.refs.set(refName, commitOid);
  return commitOid;
}

/** The commit body the contents routes answer with. */
function commitBody(repo, commitOid, message) {
  const commit = getCommit(repo, commitOid);
  return {
    sha: commitOid,
    node_id: Buffer.from(`Commit:${commitOid}`).toString('base64'),
    message: commit === null ? message : commit.message.replace(/\n$/, ''),
    url: `/api/v3/repos/${repo.fullName}/git/commits/${commitOid}`,
    author: userView(repo.owner),
    committer: userView(repo.owner),
    tree: { sha: commit === null ? '' : commit.tree },
    parents: commit === null ? [] : commit.parents.map((oid) => ({ sha: oid })),
  };
}

// ---------------------------------------------------------------- the router

/**
 * Serve one /api/v3 request. `segments` are the decoded path segments after the prefix. Answers the
 * status it wrote; the caller only logs failures.
 */
export async function handleRest(forge, req, res, segments, query) {
  const method = req.method ?? 'GET';
  const login = forge.login;

  if (segments.length === 0) {
    sendJson(res, 200, {
      current_user_url: '/api/v3/user',
      current_user_authorizations_html_url: 'https://forge.example.invalid/settings/connections/applications{/client_id}',
      authorizations_url: '/api/v3/authorizations',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      user_repositories_url: '/api/v3/user/repos',
      rate_limit_url: '/api/v3/rate_limit',
      emojis_url: '/api/v3/emojis',
    }, { 'x-oauth-scopes': SCOPES });
    return;
  }

  if (segments[0] === 'meta' && segments.length === 1) {
    sendJson(res, 200, {
      verifiable_password_authentication: false,
      installed_version: INSTALLED_VERSION,
      ssh_key_fingerprints: {},
      hooks: ['forge.example.invalid'],
    });
    return;
  }

  if (segments[0] === 'user' && segments.length === 1) {
    sendJson(res, 200, { ...userView(login), public_repos: forge.reposOf(login).length, total_private_repos: 0, followers: 0, following: 0 });
    return;
  }

  if (segments[0] === 'user' && segments[1] === 'repos' && segments.length === 2) {
    if (method === 'GET') {
      sendPage(req, res, forge.reposOf(login).reverse().map(repoView), query, '/api/v3/user/repos');
      return;
    }
    if (method === 'POST') {
      const read = await readJson(req);
      if (!read.ok) {
        apiError(res, read.tooLarge ? 413 : 400, read.tooLarge ? 'request body too large' : 'Problems parsing JSON');
        return;
      }
      const body = objectBody(read.value) ?? {};
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (name === '' || !/^[A-Za-z0-9._-]{1,100}$/.test(name)) {
        apiError(res, 422, 'Repository creation failed.', { errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name is invalid' }] });
        return;
      }
      if (forge.repo(login, name) !== null) {
        apiError(res, 422, 'Repository creation failed.', { errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }] });
        return;
      }
      const repo = forge.createRepo(login, name, {
        description: typeof body.description === 'string' ? body.description : '',
        private: body.private === true,
      });
      sendJson(res, 201, repoView(repo), { location: `/api/v3/repos/${repo.fullName}` });
      return;
    }
    apiError(res, 405, 'Method Not Allowed');
    return;
  }

  if (segments[0] === 'repos' && segments.length >= 3) {
    const repo = forge.repo(segments[1], segments[2]);
    if (repo === null) {
      apiError(res, 404, 'Not Found');
      return;
    }
    const rest = segments.slice(3);

    if (rest.length === 0) {
      if (method === 'GET') {
        sendJson(res, 200, repoView(repo));
        return;
      }
      if (method === 'PATCH') {
        const read = await readJson(req);
        if (!read.ok) {
          apiError(res, read.tooLarge ? 413 : 400, read.tooLarge ? 'request body too large' : 'Problems parsing JSON');
          return;
        }
        const body = objectBody(read.value) ?? {};
        if (typeof body.description === 'string') repo.description = body.description;
        if (typeof body.private === 'boolean') repo.private = body.private;
        if (typeof body.name === 'string' && /^[A-Za-z0-9._-]{1,100}$/.test(body.name)) {
          forge.repos.delete(forge.key(repo.owner, repo.name));
          repo.name = body.name;
          forge.repos.set(forge.key(repo.owner, repo.name), repo);
        }
        sendJson(res, 200, repoView(repo));
        return;
      }
      if (method === 'DELETE') {
        forge.deleteRepo(repo);
        sendEmpty(res, 204);
        return;
      }
      apiError(res, 405, 'Method Not Allowed');
      return;
    }

    if (rest[0] === 'branches') {
      if (rest.length === 1 && method === 'GET') {
        const branches = [...repo.refs.entries()]
          .filter(([name]) => name.startsWith('refs/heads/'))
          .map(([name, oid]) => ({ name: name.slice('refs/heads/'.length), commit: { sha: oid, url: `/api/v3/repos/${repo.fullName}/commits/${oid}` }, protected: false }));
        sendJson(res, 200, branches);
        return;
      }
      if (rest.length >= 2 && method === 'GET') {
        const branch = rest.slice(1).join('/');
        const oid = refTip(repo, `refs/heads/${branch}`);
        if (oid === null) {
          apiError(res, 404, 'Branch not found');
          return;
        }
        sendJson(res, 200, { name: branch, commit: { sha: oid, url: `/api/v3/repos/${repo.fullName}/commits/${oid}` }, protected: false });
        return;
      }
    }

    if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') {
      const revision = query.get('sha');
      const tip = resolveRevision(repo, revision ?? repo.defaultBranch);
      if (tip === null) {
        sendJson(res, 200, []);
        return;
      }
      const limit = pageOf(query, 30);
      const log = commitLog(repo, tip, limit);
      sendJson(res, 200, log.map(({ oid, commit }) => ({
        sha: oid,
        node_id: Buffer.from(`Commit:${oid}`).toString('base64'),
        url: `/api/v3/repos/${repo.fullName}/commits/${oid}`,
        html_url: `https://forge.example.invalid/${repo.fullName}/commit/${oid}`,
        commit: {
          message: commit.message.replace(/\n$/, ''),
          author: { name: commit.author.split(' <')[0] ?? '', email: repo.owner, date: repo.createdAt },
          committer: { name: commit.committer.split(' <')[0] ?? '', email: repo.owner, date: repo.createdAt },
          tree: { sha: commit.tree },
        },
        author: userView(repo.owner),
        committer: userView(repo.owner),
        parents: commit.parents.map((parent) => ({ sha: parent })),
      })));
      return;
    }

    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (rest.length === 2 && method === 'POST') {
        const read = await readJson(req);
        if (!read.ok) {
          apiError(res, read.tooLarge ? 413 : 400, 'Problems parsing JSON');
          return;
        }
        const body = objectBody(read.value) ?? {};
        const ref = typeof body.ref === 'string' ? body.ref : '';
        const sha = typeof body.sha === 'string' ? body.sha : '';
        if (!ref.startsWith('refs/') || sha === '') {
          apiError(res, 422, 'Reference update failed', { errors: [{ message: 'ref and sha are required' }] });
          return;
        }
        const target = resolveRevision(repo, sha);
        if (target === null) {
          apiError(res, 422, 'Object does not exist', { errors: [{ message: `sha ${sha} is not an object of this repository` }] });
          return;
        }
        if (repo.refs.has(ref)) {
          apiError(res, 422, 'Reference already exists', { errors: [{ message: `ref ${ref} already exists` }] });
          return;
        }
        repo.refs.set(ref, target);
        sendJson(res, 201, { ref, node_id: Buffer.from(`Ref:${ref}`).toString('base64'), url: `/api/v3/repos/${repo.fullName}/git/refs/${ref.replace(/^refs\//, '')}`, object: { sha: target, type: getCommit(repo, target) === null ? 'tag' : 'commit', url: `/api/v3/repos/${repo.fullName}/git/commits/${target}` } });
        return;
      }
      if (rest.length >= 4 && rest[2] === 'heads' && method === 'GET') {
        const branch = rest.slice(3).join('/');
        const oid = refTip(repo, `refs/heads/${branch}`);
        if (oid === null) {
          apiError(res, 404, 'Not Found');
          return;
        }
        const ref = `refs/heads/${branch}`;
        sendJson(res, 200, { ref, node_id: Buffer.from(`Ref:${ref}`).toString('base64'), url: `/api/v3/repos/${repo.fullName}/git/refs/${ref}`, object: { sha: oid, type: 'commit', url: `/api/v3/repos/${repo.fullName}/git/commits/${oid}` } });
        return;
      }
      if (rest.length === 2 && method === 'GET') {
        sendJson(res, 200, [...repo.refs.entries()].map(([ref, oid]) => ({ ref, node_id: Buffer.from(`Ref:${ref}`).toString('base64'), object: { sha: oid, type: 'commit' } })));
        return;
      }
    }

    if (rest[0] === 'git' && rest[1] === 'commits' && rest.length >= 3 && method === 'GET') {
      const commit = getCommit(repo, rest[2]);
      if (commit === null) {
        apiError(res, 404, 'Not Found');
        return;
      }
      sendJson(res, 200, commitBody(repo, rest[2], ''));
      return;
    }

    if (rest[0] === 'contents') {
      const path = rest.slice(1).join('/');
      const ref = query.get('ref');
      if (method === 'GET') {
        const tree = treeForRef(repo, ref);
        if (tree === null) {
          apiError(res, 404, 'Not Found');
          return;
        }
        if (path === '') {
          sendJson(res, 200, directoryListing(repo, tree, ''));
          return;
        }
        const entry = pathEntry(repo, tree, path.split('/'));
        if (entry === null) {
          apiError(res, 404, 'Not Found');
          return;
        }
        if (entry.mode === '40000') {
          sendJson(res, 200, directoryListing(repo, entry.oid, path));
          return;
        }
        sendJson(res, 200, fileView(repo, path, entry.oid));
        return;
      }
      const read = await readJson(req);
      if (!read.ok) {
        apiError(res, read.tooLarge ? 413 : 400, read.tooLarge ? 'request body too large' : 'Problems parsing JSON');
        return;
      }
      const body = objectBody(read.value) ?? {};
      const message = typeof body.message === 'string' && body.message !== '' ? body.message : 'update';
      const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
      if (method === 'PUT') {
        const content = typeof body.content === 'string' ? body.content.replace(/[\r\n\t ]+/g, '') : '';
        let data;
        try {
          data = Buffer.from(content, 'base64');
        } catch {
          apiError(res, 422, 'Content is not valid Base64');
          return;
        }
        const refName = `refs/heads/${branch}`;
        let parent = refTip(repo, refName);
        if (parent === null && branch !== repo.defaultBranch) {
          const fallback = refTip(repo, `refs/heads/${repo.defaultBranch}`);
          if (fallback !== null) {
            repo.refs.set(refName, fallback);
            parent = fallback;
          }
        }
        const parentTree = parent === null ? null : commitTree(repo, parent);
        const existing = parentTree === null ? null : pathEntry(repo, parentTree, path.split('/'));
        if (body.sha !== undefined && body.sha !== null) {
          if (existing === null || existing.oid !== body.sha) {
            apiError(res, 409, 'sha does not match the current content', { errors: [{ message: 'sha does not match the current content' }] });
            return;
          }
        } else if (existing !== null) {
          apiError(res, 422, 'Invalid request.', { errors: [{ resource: 'Content', code: 'missing_field', field: 'sha', message: 'sha wasn\'t supplied.' }] });
          return;
        }
        const blobOid = putObject(repo, 'blob', data);
        const commitOid = commitPath(forge, repo, { branch, path, blobOid, message });
        const status = existing === null ? 201 : 200;
        sendJson(res, status, {
          content: { type: 'file', encoding: 'base64', size: data.length, name: path.split('/').pop(), path, sha: blobOid, content: data.toString('base64') },
          commit: commitBody(repo, commitOid, message),
        });
        return;
      }
      if (method === 'DELETE') {
        const refName = `refs/heads/${branch}`;
        const parent = refTip(repo, refName);
        const parentTree = parent === null ? null : commitTree(repo, parent);
        const existing = parentTree === null ? null : pathEntry(repo, parentTree, path.split('/'));
        if (existing === null) {
          apiError(res, 404, 'Not Found');
          return;
        }
        if (typeof body.sha === 'string' && body.sha !== '' && existing.oid !== body.sha) {
          apiError(res, 409, 'sha does not match the current content', { errors: [{ message: 'sha does not match the current content' }] });
          return;
        }
        const commitOid = commitPath(forge, repo, { branch, path, blobOid: null, message });
        sendJson(res, 200, { content: null, commit: commitBody(repo, commitOid, message) });
        return;
      }
    }

    if (rest[0] === 'labels') {
      if (method === 'GET' && rest.length === 1) {
        sendJson(res, 200, [...repo.labels.keys()].map((name) => labelView(repo, name)));
        return;
      }
      if (method === 'POST' && rest.length === 1) {
        const read = await readJson(req);
        if (!read.ok) {
          apiError(res, read.tooLarge ? 413 : 400, 'Problems parsing JSON');
          return;
        }
        const body = objectBody(read.value) ?? {};
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        if (name === '') {
          apiError(res, 422, 'Validation Failed', { errors: [{ resource: 'Label', code: 'missing_field', field: 'name' }] });
          return;
        }
        const color = typeof body.color === 'string' ? body.color.replace('#', '') : 'ededed';
        repo.labels.set(name, color);
        sendJson(res, 201, labelView(repo, name), { location: `/api/v3/repos/${repo.fullName}/labels/${name}` });
        return;
      }
    }

    if (rest[0] === 'issues') {
      if (method === 'GET' && rest.length === 1) {
        const state = query.get('state') ?? 'open';
        const sort = query.get('sort') ?? 'created';
        const direction = (query.get('direction') ?? 'desc').toLowerCase();
        const wantedLabels = query.get('labels');
        let issues = repo.issues.slice();
        if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
        if (wantedLabels !== null && wantedLabels !== '') {
          const names = wantedLabels.split(',').map((name) => name.trim()).filter(Boolean);
          issues = issues.filter((issue) => names.every((name) => issue.labels.includes(name)));
        }
        const key = (issue) => (sort === 'updated' ? issue.updatedAt : issue.createdAt);
        issues.sort((a, b) => (direction === 'asc' ? key(a).localeCompare(key(b)) || a.number - b.number : key(b).localeCompare(key(a)) || b.number - a.number));
        sendPage(req, res, issues.map((issue) => issueView(repo, issue)), query, `/api/v3/repos/${repo.fullName}/issues`);
        return;
      }
      if (method === 'POST' && rest.length === 1) {
        const read = await readJson(req);
        if (!read.ok) {
          apiError(res, read.tooLarge ? 413 : 400, read.tooLarge ? 'request body too large' : 'Problems parsing JSON');
          return;
        }
        const body = objectBody(read.value) ?? {};
        let issue;
        try {
          issue = createIssueAction(forge, repo, body);
        } catch (error) {
          if (!(error instanceof ActionError)) throw error;
          apiError(res, error.status, 'Validation Failed', { errors: [{ resource: 'Issue', code: 'invalid', field: 'title', message: error.message }] });
          return;
        }
        sendJson(res, 201, issueView(repo, issue), { location: `/api/v3/repos/${repo.fullName}/issues/${issue.number}` });
        return;
      }
      if (rest.length === 2 && method === 'GET') {
        const issue = repo.issues.find((candidate) => String(candidate.number) === rest[1]);
        if (issue === undefined) {
          apiError(res, 404, 'Not Found');
          return;
        }
        sendJson(res, 200, issueView(repo, issue));
        return;
      }
      if (rest.length === 2 && method === 'PATCH') {
        const issue = repo.issues.find((candidate) => String(candidate.number) === rest[1]);
        if (issue === undefined) {
          apiError(res, 404, 'Not Found');
          return;
        }
        const read = await readJson(req);
        if (!read.ok) {
          apiError(res, read.tooLarge ? 413 : 400, 'Problems parsing JSON');
          return;
        }
        const body = objectBody(read.value) ?? {};
        if (typeof body.title === 'string' && body.title !== '') issue.title = body.title;
        if (typeof body.body === 'string') issue.body = body.body;
        if (typeof body.state === 'string' && (body.state === 'open' || body.state === 'closed')) {
          setIssueStateAction(forge, repo, issue, body.state);
        }
        if (Array.isArray(body.labels)) {
          const names = body.labels.filter((name) => typeof name === 'string');
          const unknown = names.filter((name) => !repo.labels.has(name));
          if (unknown.length > 0) {
            apiError(res, 422, 'Validation Failed', { errors: unknown.map((name) => ({ resource: 'Label', code: 'invalid', field: 'labels', message: `label ${name} does not exist` })) });
            return;
          }
          issue.labels = names;
        }
        issue.updatedAt = forge.tick();
        sendJson(res, 200, issueView(repo, issue));
        return;
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        const issue = repo.issues.find((candidate) => String(candidate.number) === rest[1]);
        if (issue === undefined) {
          apiError(res, 404, 'Not Found');
          return;
        }
        const comments = repo.comments.get(issue.number) ?? [];
        if (method === 'GET') {
          sendPage(req, res, comments.map((comment) => commentView(repo, issue, comment)), query, `/api/v3/repos/${repo.fullName}/issues/${issue.number}/comments`);
          return;
        }
        if (method === 'POST') {
          const read = await readJson(req);
          if (!read.ok) {
            apiError(res, read.tooLarge ? 413 : 400, 'Problems parsing JSON');
            return;
          }
          const body = objectBody(read.value) ?? {};
          let comment;
          try {
            comment = addCommentAction(forge, repo, issue, body.body);
          } catch (error) {
            if (!(error instanceof ActionError)) throw error;
            apiError(res, error.status, 'Validation Failed', { errors: [{ resource: 'IssueComment', code: 'missing_field', field: 'body' }] });
            return;
          }
          sendJson(res, 201, commentView(repo, issue, comment), { location: `/api/v3/repos/${repo.fullName}/issues/comments/${comment.id}` });
          return;
        }
      }
    }

    if (rest[0] === 'pulls') {
      if (method === 'GET' && rest.length === 1) {
        const state = query.get('state') ?? 'open';
        let pulls = repo.pulls.slice();
        if (state === 'open') pulls = pulls.filter((pull) => !pull.merged && pull.state === 'open');
        else if (state === 'closed') pulls = pulls.filter((pull) => pull.merged || pull.state === 'closed');
        pulls.sort((a, b) => a.number - b.number);
        sendPage(req, res, pulls.map((pull) => pullView(repo, pull)), query, `/api/v3/repos/${repo.fullName}/pulls`);
        return;
      }
      if (method === 'POST' && rest.length === 1) {
        const read = await readJson(req);
        if (!read.ok) {
          apiError(res, read.tooLarge ? 413 : 400, read.tooLarge ? 'request body too large' : 'Problems parsing JSON');
          return;
        }
        const body = objectBody(read.value) ?? {};
        let pull;
        try {
          pull = createPullAction(forge, repo, body);
        } catch (error) {
          if (!(error instanceof ActionError)) throw error;
          apiError(res, 422, 'Validation Failed', { errors: [{ resource: 'PullRequest', code: 'invalid', field: 'head', message: error.message }] });
          return;
        }
        sendJson(res, 201, pullView(repo, pull), { location: `/api/v3/repos/${repo.fullName}/pulls/${pull.number}` });
        return;
      }
      if (rest.length === 2 && method === 'GET') {
        const pull = repo.pulls.find((candidate) => String(candidate.number) === rest[1]);
        if (pull === undefined) {
          apiError(res, 404, 'Not Found');
          return;
        }
        sendJson(res, 200, pullView(repo, pull));
        return;
      }
      if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
        const pull = repo.pulls.find((candidate) => String(candidate.number) === rest[1]);
        if (pull === undefined) {
          apiError(res, 404, 'Not Found');
          return;
        }
        sendPage(req, res, pullFiles(repo, pull), query, `/api/v3/repos/${repo.fullName}/pulls/${pull.number}/files`);
        return;
      }
      if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
        const pull = repo.pulls.find((candidate) => String(candidate.number) === rest[1]);
        if (pull === undefined) {
          apiError(res, 404, 'Not Found');
          return;
        }
        const read = await readJson(req);
        const body = read.ok ? (objectBody(read.value) ?? {}) : {};
        const mergeMethod = typeof body.merge_method === 'string' ? body.merge_method : 'merge';
        let sha;
        try {
          sha = mergePullAction(forge, repo, pull, mergeMethod);
        } catch (error) {
          if (!(error instanceof ActionError)) throw error;
          apiError(res, error.status, 'Pull Request is not mergeable', { errors: [{ message: 'Pull Request is not mergeable' }] });
          return;
        }
        sendJson(res, 200, { sha, merged: true, message: 'Pull Request successfully merged' });
        return;
      }
    }

    apiError(res, 404, 'Not Found');
    return;
  }

  apiError(res, 404, 'Not Found');
}

export { flattenTree, isAncestor, lineDelta, ZERO_OID };
