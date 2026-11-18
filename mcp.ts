// @ts-nocheck — the runtime strips types; there is no type-checking step in the trial pod.
// The MCP endpoint: JSON-RPC 2.0 over the streamable-HTTP transport, serving the tool surface an
// agent uses (create_repo, get_repo, create_issue, list_issues, create_pull_request,
// merge_pull_request and a few more), acting on the same store as REST.
//
// Both protocol eras are answered: `server/discover` (2026-07-28, every request declaring its
// revision in `_meta`) and the older `initialize` handshake (2025-11-25 and earlier). There is no
// session state: each POST is one JSON-RPC message and one JSON answer, so two calls in flight keep
// their own ids by construction.

import { readBody, sendEmpty, sendJson } from './http.ts';
import { ActionError, createIssueAction, createPullAction, mergePullAction } from './actions.ts';

/** The revision this server prefers and the ones it also speaks. */
const REVISIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'makefun-forge', version: '1.0.0' };

/** The credential a request presents, as a bearer token or as Basic auth's password. */
function credentialOf(req) {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const text = header.trim();
  const bearer = /^Bearer\s+(.+)$/i.exec(text);
  if (bearer !== null) return bearer[1].trim();
  const basic = /^Basic\s+(.+)$/i.exec(text);
  if (basic !== null) {
    const decoded = Buffer.from(basic[1].trim(), 'base64').toString('utf8');
    const colon = decoded.indexOf(':');
    return colon < 0 ? decoded : decoded.slice(colon + 1);
  }
  return null;
}

/** The tool table. Built once, so two `tools/list` answers are the same bytes. */
const TOOLS = Object.freeze([
  {
    name: 'create_repo',
    title: 'Create a repository',
    description: 'Create a repository in the forge, owned by the token\'s login. Answers the repository object.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'What the repository is for.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_repo',
    title: 'Read a repository',
    description: 'Read one repository by owner and name. Answers its name, ids, owner, description and default branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login that owns the repository.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_issue',
    title: 'Open an issue',
    description: 'Open an issue in a repository. Answers the created issue with its number and id.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login that owns the repository.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_issues',
    title: 'List issues',
    description: 'List a repository\'s issues, open by default. Answers an array of issues with numbers, titles and states.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login that owns the repository.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed, or all.', enum: ['open', 'closed', 'all'] },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_issue',
    title: 'Read an issue',
    description: 'Read one issue of a repository by its number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login that owns the repository.' },
        repo: { type: 'string', description: 'The repository name.' },
        number: { type: 'integer', description: 'The issue number.' },
      },
      required: ['owner', 'repo', 'number'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_pull_request',
    title: 'Open a pull request',
    description: 'Open a pull request from a head branch into a base branch. Answers the pull request with its number, state and refs.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login that owns the repository.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The branch the change comes from.' },
        base: { type: 'string', description: 'The branch the change goes into.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_pulls',
    title: 'List pull requests',
    description: 'List a repository\'s pull requests, open by default.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login that owns the repository.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed, or all.', enum: ['open', 'closed', 'all'] },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'merge_pull_request',
    title: 'Merge a pull request',
    description: 'Merge a pull request into its base branch. Answers the pull request and whether it merged.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login that owns the repository.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_repos',
    title: 'List repositories',
    description: 'List every repository the token\'s login owns.',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
]);

/** The tool list in the shape tools/list answers. `TOOLS` is frozen, so this is byte-stable. */
const TOOL_LIST = JSON.stringify({ tools: TOOLS });

/** A repository as the tools report it. */
function repoSummary(repo) {
  return {
    id: repo.id,
    name: repo.name,
    full_name: repo.fullName,
    owner: { login: repo.owner },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
  };
}

/** An issue as the tools report it. */
function issueSummary(repo, issue) {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name })),
    user: { login: issue.author },
    repository: repo.fullName,
    created_at: issue.createdAt,
  };
}

/** A pull request as the tools report it. */
function pullSummary(repo, pull) {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.merged ? 'closed' : pull.state,
    merged: pull.merged,
    head: { ref: pull.head, sha: pull.headSha },
    base: { ref: pull.base, sha: pull.baseSha },
    repository: repo.fullName,
  };
}

/** A tool's failure the JSON-RPC layer turns into an isError result. */
class ToolError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ToolError';
  }
}

/** The repository a tool names, or a ToolError. */
function repoOf(forge, args) {
  const owner = typeof args.owner === 'string' ? args.owner : forge.login;
  const name = typeof args.repo === 'string' ? args.repo : typeof args.repository === 'string' ? args.repository : '';
  if (name === '') throw new ToolError('repo is required');
  const repo = forge.repo(owner, name);
  if (repo === null) throw new ToolError(`no repository ${owner}/${name}`);
  return repo;
}

/** The required properties a tool's schema declares. */
function requiredOf(tool) {
  const schema = tool.inputSchema ?? {};
  return Array.isArray(schema.required) ? schema.required : [];
}

/** Run one tool. Answers the JSON value the result carries; throws ToolError for a tool failure. */
function runTool(forge, name, args) {
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (tool === undefined) throw new ToolError(`no tool named ${name}`);
  for (const property of requiredOf(tool)) {
    if (args[property] === undefined || args[property] === null || args[property] === '') {
      throw new ToolError(`the ${name} tool requires ${property}`);
    }
  }
  if (name === 'create_repo') {
    const repoName = String(args.name);
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(repoName)) throw new ToolError('that repository name is not valid');
    const existing = forge.repo(forge.login, repoName);
    if (existing !== null) return repoSummary(existing);
    const repo = forge.createRepo(forge.login, repoName, {
      description: typeof args.description === 'string' ? args.description : '',
      private: args.private === true,
    });
    return repoSummary(repo);
  }
  if (name === 'get_repo') return repoSummary(repoOf(forge, args));
  if (name === 'list_repos') return forge.reposOf(forge.login).map(repoSummary);
  if (name === 'create_issue') {
    const repo = repoOf(forge, args);
    const issue = createIssueAction(forge, repo, { title: args.title, body: args.body });
    return issueSummary(repo, issue);
  }
  if (name === 'list_issues') {
    const repo = repoOf(forge, args);
    const state = typeof args.state === 'string' ? args.state : 'open';
    const issues = repo.issues.filter((issue) => state === 'all' || issue.state === state);
    return issues.map((issue) => issueSummary(repo, issue));
  }
  if (name === 'get_issue') {
    const repo = repoOf(forge, args);
    const number = Number(args.number);
    const issue = repo.issues.find((candidate) => candidate.number === number);
    if (issue === undefined) throw new ToolError(`no issue #${args.number} in ${repo.fullName}`);
    return issueSummary(repo, issue);
  }
  if (name === 'create_pull_request') {
    const repo = repoOf(forge, args);
    const pull = createPullAction(forge, repo, { title: args.title, body: args.body, head: args.head, base: args.base });
    return pullSummary(repo, pull);
  }
  if (name === 'list_pulls') {
    const repo = repoOf(forge, args);
    const state = typeof args.state === 'string' ? args.state : 'open';
    const pulls = repo.pulls.filter((pull) => state === 'all' || (pull.merged ? 'closed' : pull.state) === state);
    return pulls.map((pull) => pullSummary(repo, pull));
  }
  if (name === 'merge_pull_request') {
    const repo = repoOf(forge, args);
    const number = Number(args.pull_number);
    const pull = repo.pulls.find((candidate) => candidate.number === number);
    if (pull === undefined) throw new ToolError(`no pull request #${args.pull_number} in ${repo.fullName}`);
    mergePullAction(forge, repo, pull, 'SQUASH');
    return pullSummary(repo, pull);
  }
  throw new ToolError(`the ${name} tool has no implementation`);
}

/** A tool result: the JSON value as text plus structured content. */
function toolResult(value) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
    isError: false,
  };
}

/** A tool failure: the message as text, `isError: true`. */
function toolFailure(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** One JSON-RPC message answered: the response object, or null for a notification. */
function answer(forge, message) {
  if (typeof message !== 'object' || message === null || Array.isArray(message)) {
    return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } };
  }
  const id = message.id === undefined ? null : message.id;
  const isNotification = message.id === undefined;
  const method = typeof message.method === 'string' ? message.method : '';
  const params = typeof message.params === 'object' && message.params !== null ? message.params : {};
  const reply = (result) => (isNotification ? null : { jsonrpc: '2.0', id, result });
  const fail = (code, text) => (isNotification ? null : { jsonrpc: '2.0', id, error: { code, message: text } });

  if (method === 'server/discover') {
    return reply({
      resultType: 'complete',
      supportedVersions: REVISIONS.slice(),
      capabilities: { tools: { listChanged: false } },
      instructions: 'A GitHub-compatible forge: repositories, issues, pull requests and git over HTTP.',
      serverInfo: { ...SERVER_INFO },
      _meta: { 'io.modelcontextprotocol/serverInfo': { ...SERVER_INFO } },
    });
  }
  if (method === 'initialize') {
    const wanted = typeof params.protocolVersion === 'string' ? params.protocolVersion : REVISIONS[0];
    const version = REVISIONS.includes(wanted) ? wanted : REVISIONS[0];
    return reply({
      protocolVersion: version,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { ...SERVER_INFO },
      instructions: 'A GitHub-compatible forge: repositories, issues, pull requests and git over HTTP.',
    });
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return null;
  if (method === 'ping') return reply({});
  if (method === 'tools/list') return isNotification ? null : { jsonrpc: '2.0', id, result: JSON.parse(TOOL_LIST) };
  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {};
    if (name === '') return fail(-32602, 'tools/call needs a tool name');
    const tool = TOOLS.find((candidate) => candidate.name === name);
    if (tool === undefined) return fail(-32602, `no tool named ${name}`);
    try {
      return isNotification ? null : { jsonrpc: '2.0', id, result: toolResult(runTool(forge, name, args)) };
    } catch (error) {
      const text = error instanceof ActionError || error instanceof ToolError ? error.message : `the tool failed: ${error.message ?? error}`;
      return isNotification ? null : { jsonrpc: '2.0', id, result: toolFailure(text) };
    }
  }
  if (method === 'resources/list') return reply({ resources: [] });
  if (method === 'prompts/list') return reply({ prompts: [] });
  return fail(-32601, `method not found: ${method}`);
}

/** Serve one /mcp request. */
export async function handleMcp(forge, req, res, token) {
  const method = req.method ?? 'GET';
  const presented = credentialOf(req);
  if (presented === null || (token !== '' && presented !== token)) {
    sendJson(res, 401, { message: 'Requires authentication' }, { 'www-authenticate': 'Basic realm="makefun-forge"' });
    return;
  }
  if (method === 'DELETE') {
    sendEmpty(res, 204);
    return;
  }
  if (method !== 'POST') {
    sendJson(res, 405, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'the MCP endpoint takes POST' } });
    return;
  }
  const raw = await readBody(req, 8 * 1024 * 1024);
  if (raw === null) {
    sendJson(res, 413, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'request body too large' } });
    return;
  }
  let body;
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error: the body is not JSON' } });
    return;
  }
  if (Array.isArray(body)) {
    const answers = [];
    for (const message of body) {
      const answered = answer(forge, message);
      if (answered !== null) answers.push(answered);
    }
    if (answers.length === 0) {
      sendEmpty(res, 202);
      return;
    }
    sendJson(res, 200, answers);
    return;
  }
  const answered = answer(forge, body);
  if (answered === null) {
    sendEmpty(res, 202);
    return;
  }
  sendJson(res, 200, answered);
}
