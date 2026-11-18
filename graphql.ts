// @ts-nocheck — the runtime strips types; there is no type-checking step in the trial pod.
// The GraphQL v4 endpoint: a hand-written parser and executor for the documents gh and
// github-mcp-server send, over the forge's own store.
//
// What it implements: queries and mutations with variables, inline enums and input objects, named
// operations, inline fragments (`... on Repository`), operation batching (a JSON array of documents
// answers an array of results in order), the `__type` introspection gh's feature probes read, and a
// schema whose field list is the one the checks describe. An unknown field is HTTP 200 with an
// `errors` array naming it — never a 400, never a crash — and an unknown repository is
// `data.repository: null` with no errors.

import { readBody, sendJson } from './http.ts';
import {
  ActionError,
  addCommentAction,
  createIssueAction,
  createPullAction,
  mergePullAction,
  pullConflict,
  pullFiles,
  pullTrees,
  setIssueStateAction,
} from './actions.ts';

// ---------------------------------------------------------------- lexer

/** Turn a document into tokens: names, strings, numbers, and the punctuation GraphQL uses. */
function lex(src) {
  const tokens = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '\ufeff') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < n && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '.' && src[i + 1] === '.' && src[i + 2] === '.') {
      tokens.push({ t: 'punct', v: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:=!$|&@'.includes(c)) {
      tokens.push({ t: 'punct', v: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      if (src[i + 1] === '"' && src[i + 2] === '"') {
        const end = src.indexOf('"""', i + 3);
        tokens.push({ t: 'str', v: end < 0 ? src.slice(i + 3) : src.slice(i + 3, end) });
        i = end < 0 ? n : end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < n && src[j] !== '"') {
        if (src[j] === '\\') {
          const esc = src[j + 1];
          if (esc === 'u') {
            out += String.fromCharCode(Number.parseInt(src.slice(j + 2, j + 6), 16));
            j += 6;
            continue;
          }
          const map = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
          out += map[esc] ?? esc;
          j += 2;
          continue;
        }
        out += src[j];
        j += 1;
      }
      tokens.push({ t: 'str', v: out });
      i = j + 1;
      continue;
    }
    if (/[-0-9]/.test(c)) {
      let j = i;
      if (src[j] === '-') j += 1;
      while (j < n && /[0-9]/.test(src[j])) j += 1;
      let kind = 'int';
      if (src[j] === '.') {
        kind = 'float';
        j += 1;
        while (j < n && /[0-9]/.test(src[j])) j += 1;
      }
      if (src[j] === 'e' || src[j] === 'E') {
        kind = 'float';
        j += 1;
        if (src[j] === '+' || src[j] === '-') j += 1;
        while (j < n && /[0-9]/.test(src[j])) j += 1;
      }
      tokens.push({ t: kind, v: Number(src.slice(i, j)) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(c)) {
      let j = i;
      while (j < n && /[_0-9A-Za-z]/.test(src[j])) j += 1;
      tokens.push({ t: 'name', v: src.slice(i, j) });
      i = j;
      continue;
    }
    i += 1;
  }
  tokens.push({ t: 'eof', v: '' });
  return tokens;
}

// ---------------------------------------------------------------- parser

/**
 * Parse one document into its operations and fragments. A syntax error throws, and the caller turns
 * it into an `errors` array (the wire's answer to an unparsable document).
 */
function parseDocument(src) {
  const tokens = lex(src);
  let pos = 0;
  const peek = (k) => tokens[Math.min(pos + (k ?? 0), tokens.length - 1)];
  const next = () => tokens[pos++];
  const at = (t, v) => peek().t === t && (v === undefined || peek().v === v);
  const expect = (t, v) => {
    const token = next();
    if (token.t !== t || (v !== undefined && token.v !== v)) {
      throw new Error(`expected ${v ?? t}, found ${JSON.stringify(token.v)}`);
    }
    return token;
  };

  function skipDirectives() {
    while (at('punct', '@')) {
      next();
      expect('name');
      if (at('punct', '(')) {
        next();
        let depth = 1;
        while (depth > 0 && !at('eof')) {
          const token = next();
          if (token.t === 'punct' && token.v === '(') depth += 1;
          if (token.t === 'punct' && token.v === ')') depth -= 1;
        }
      }
    }
  }

  function parseType() {
    if (at('punct', '[')) {
      next();
      parseType();
      expect('punct', ']');
    } else {
      expect('name');
    }
    if (at('punct', '!')) next();
  }

  function parseValue() {
    const token = peek();
    if (token.t === 'punct' && token.v === '$') {
      next();
      return { kind: 'variable', name: expect('name').v };
    }
    if (token.t === 'int' || token.t === 'float' || token.t === 'str') {
      next();
      return { kind: 'literal', value: token.v };
    }
    if (token.t === 'name') {
      next();
      if (token.v === 'true') return { kind: 'literal', value: true };
      if (token.v === 'false') return { kind: 'literal', value: false };
      if (token.v === 'null') return { kind: 'literal', value: null };
      return { kind: 'literal', value: token.v };
    }
    if (token.t === 'punct' && token.v === '[') {
      next();
      const items = [];
      while (!at('punct', ']')) items.push(parseValue());
      next();
      return { kind: 'list', items };
    }
    if (token.t === 'punct' && token.v === '{') {
      next();
      const entries = [];
      while (!at('punct', '}')) {
        const name = expect('name').v;
        expect('punct', ':');
        entries.push([name, parseValue()]);
      }
      next();
      return { kind: 'object', entries };
    }
    throw new Error(`unexpected token ${JSON.stringify(token.v)}`);
  }

  function parseArguments() {
    expect('punct', '(');
    const args = [];
    while (!at('punct', ')')) {
      const name = expect('name').v;
      expect('punct', ':');
      args.push([name, parseValue()]);
    }
    next();
    return args;
  }

  function parseSelectionSet() {
    expect('punct', '{');
    const selections = [];
    while (!at('punct', '}')) selections.push(parseSelection());
    next();
    return selections;
  }

  function parseSelection() {
    if (at('punct', '...')) {
      next();
      if (at('name', 'on')) {
        next();
        const typeCondition = expect('name').v;
        skipDirectives();
        return { kind: 'inlineFragment', typeCondition, selections: parseSelectionSet() };
      }
      const name = expect('name').v;
      skipDirectives();
      return { kind: 'fragment', name };
    }
    let name = expect('name').v;
    let alias = null;
    if (at('punct', ':')) {
      next();
      alias = name;
      name = expect('name').v;
    }
    const args = at('punct', '(') ? parseArguments() : [];
    skipDirectives();
    const selections = at('punct', '{') ? parseSelectionSet() : null;
    return { kind: 'field', alias, name, args, selections };
  }

  function parseOperation() {
    let type = 'query';
    let name = null;
    if (at('name', 'query') || at('name', 'mutation') || at('name', 'subscription')) {
      type = next().v;
      if (at('name')) name = next().v;
    }
    const variableDefs = [];
    if (at('punct', '(')) {
      next();
      while (!at('punct', ')')) {
        expect('punct', '$');
        const variable = expect('name').v;
        expect('punct', ':');
        parseType();
        let fallback;
        if (at('punct', '=')) {
          next();
          fallback = parseValue();
        }
        variableDefs.push({ name: variable, default: fallback });
      }
      next();
    }
    skipDirectives();
    return { type, name, variableDefs, selections: parseSelectionSet() };
  }

  const operations = [];
  const fragments = new Map();
  while (!at('eof')) {
    if (at('name', 'fragment')) {
      next();
      const name = expect('name').v;
      expect('name', 'on');
      const typeCondition = expect('name').v;
      skipDirectives();
      fragments.set(name, { typeCondition, selections: parseSelectionSet() });
      continue;
    }
    if (at('punct', '{')) {
      operations.push({ type: 'query', name: null, variableDefs: [], selections: parseSelectionSet() });
      continue;
    }
    operations.push(parseOperation());
  }
  return { operations, fragments };
}

// ---------------------------------------------------------------- type references

const scalar = () => ({ kind: 'scalar' });
const object = (name) => ({ kind: 'object', name });
const listOf = (name) => ({ kind: 'list', of: object(name) });

/** The schema: each type's fields, each field's result type and resolver. */
const TYPES = {};

function defineType(name, kind, fields) {
  TYPES[name] = { name, kind, fields: fields ?? {} };
}

function field(type, resolve, args) {
  return { type, resolve, args: args ?? {} };
}

// ---------------------------------------------------------------- ids and cursors

function globalId(kind, parts) {
  return Buffer.from(`${kind}:${parts.join(':')}`).toString('base64');
}

function parseGlobalId(id) {
  if (typeof id !== 'string' || id === '') return null;
  let text;
  try {
    text = Buffer.from(id, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const parts = text.split(':');
  if (parts.length < 2) return null;
  return { kind: parts[0], parts: parts.slice(1) };
}

function repoById(forge, id) {
  for (const repo of forge.repos.values()) if (String(repo.id) === String(id)) return repo;
  return null;
}

function issueStateName(issue) {
  return issue.state === 'closed' ? 'CLOSED' : 'OPEN';
}

function pullStateName(pull) {
  if (pull.merged) return 'MERGED';
  return pull.state === 'closed' ? 'CLOSED' : 'OPEN';
}

const CURSOR_PREFIX = 'cursor:';

function encodeCursor(index) {
  return Buffer.from(`${CURSOR_PREFIX}${index}`).toString('base64');
}

function decodeCursor(text) {
  if (typeof text !== 'string' || text === '') return null;
  let decoded;
  try {
    decoded = Buffer.from(text, 'base64').toString('utf8');
  } catch {
    return null;
  }
  if (!decoded.startsWith(CURSOR_PREFIX)) return null;
  const value = Number.parseInt(decoded.slice(CURSOR_PREFIX.length), 10);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

// ---------------------------------------------------------------- connections

/** A page of issues, ordered the way the document asks, with index cursors. */
function issuePage(repo, args) {
  const first = typeof args.first === 'number' && args.first > 0 ? args.first : 100;
  const states = Array.isArray(args.states) && args.states.length > 0 ? args.states : null;
  const orderBy = args.orderBy ?? {};
  const direction = orderBy.direction === 'ASC' ? 1 : -1;
  const orderField = orderBy.field ?? 'CREATED_AT';
  let items = repo.issues.slice();
  if (states !== null) items = items.filter((issue) => states.includes(issueStateName(issue)));
  items.sort((a, b) => {
    const left = orderField === 'UPDATED_AT' ? a.updatedAt : orderField === 'COMMENTS' ? a.comments : a.createdAt;
    const right = orderField === 'UPDATED_AT' ? b.updatedAt : orderField === 'COMMENTS' ? b.comments : b.createdAt;
    const compared = typeof left === 'number' && typeof right === 'number' ? left - right : String(left).localeCompare(String(right));
    return (compared !== 0 ? compared : a.number - b.number) * direction;
  });
  const after = decodeCursor(args.after);
  const start = after === null ? 0 : Math.min(items.length, after + 1);
  const nodes = items.slice(start, start + first);
  return {
    nodes,
    totalCount: items.length,
    pageInfo: {
      hasNextPage: start + first < items.length,
      hasPreviousPage: start > 0,
      startCursor: nodes.length === 0 ? null : encodeCursor(start),
      endCursor: nodes.length === 0 ? null : encodeCursor(start + nodes.length - 1),
    },
  };
}

/** A page of pull requests, newest number last. */
function pullPage(repo, args) {
  const first = typeof args.first === 'number' && args.first > 0 ? args.first : 50;
  const items = repo.pulls.slice().sort((a, b) => a.number - b.number);
  const nodes = items.slice(0, first);
  return {
    nodes,
    totalCount: items.length,
    pageInfo: { hasNextPage: items.length > first, hasPreviousPage: false, startCursor: nodes.length === 0 ? null : encodeCursor(0), endCursor: nodes.length === 0 ? null : encodeCursor(nodes.length - 1) },
  };
}

// ---------------------------------------------------------------- the types

defineType('Query', 'OBJECT', {
  viewer: field(object('User'), (_value, _args, ctx) => ({ login: ctx.forge.login })),
  repository: field(object('Repository'), (value, args, ctx) => ctx.forge.repo(args.owner ?? '', args.name ?? '') ?? null),
  node: field(object('Node'), (value, args, ctx) => nodeOf(ctx.forge, args.id)),
  __type: field(object('__Type'), (value, args) => typeInfo(args.name)),
  __schema: field(object('__Schema'), () => ({ queryType: { name: 'Query' }, mutationType: { name: 'Mutation' }, types: [] })),
});

function nodeOf(forge, id) {
  const parsed = parseGlobalId(id);
  if (parsed === null) return null;
  if (parsed.kind === 'Repository') {
    const repo = repoById(forge, parsed.parts[0]);
    return repo === null ? null : { __type: 'Repository', value: repo };
  }
  if (parsed.kind === 'Issue') {
    const repo = repoById(forge, parsed.parts[0]);
    const issue = repo === null ? undefined : repo.issues.find((candidate) => String(candidate.number) === String(parsed.parts[1]));
    return issue === undefined ? null : { __type: 'Issue', value: { repo, issue } };
  }
  if (parsed.kind === 'PullRequest') {
    const repo = repoById(forge, parsed.parts[0]);
    const pull = repo === null ? undefined : repo.pulls.find((candidate) => String(candidate.number) === String(parsed.parts[1]));
    return pull === undefined ? null : { __type: 'PullRequest', value: { repo, pull } };
  }
  return null;
}

defineType('User', 'OBJECT', {
  login: field(scalar(), (value) => value.login),
  id: field(scalar(), (value) => globalId('User', [value.login])),
  databaseId: field(scalar(), () => 1000),
  name: field(scalar(), (value) => value.name ?? value.login),
  url: field(scalar(), (value) => `https://forge.example.invalid/${value.login}`),
});

defineType('Repository', 'OBJECT', {
  id: field(scalar(), (repo) => globalId('Repository', [repo.id])),
  databaseId: field(scalar(), (repo) => repo.id),
  name: field(scalar(), (repo) => repo.name),
  nameWithOwner: field(scalar(), (repo) => repo.fullName),
  owner: field(object('User'), (repo) => ({ login: repo.owner })),
  description: field(scalar(), (repo) => repo.description),
  isPrivate: field(scalar(), (repo) => repo.private),
  isEmpty: field(scalar(), (repo) => repo.refs.size === 0),
  createdAt: field(scalar(), (repo) => repo.createdAt),
  url: field(scalar(), (repo) => `https://forge.example.invalid/${repo.fullName}`),
  defaultBranchRef: field(object('Ref'), (repo) => ({ name: repo.defaultBranch, repository: repo })),
  viewerPermission: field(scalar(), () => 'ADMIN'),
  hasIssuesEnabled: field(scalar(), () => true),
  issue: field(object('Issue'), (repo, args) => {
    const issue = repo.issues.find((candidate) => candidate.number === Number(args.number));
    return issue === undefined ? null : { repo, issue };
  }),
  issues: field(object('IssueConnection'), (repo, args) => {
    const page = issuePage(repo, args);
    return { repo, nodes: page.nodes.map((issue) => ({ repo, issue })), totalCount: page.totalCount, pageInfo: page.pageInfo };
  }),
  pullRequest: field(object('PullRequest'), (repo, args) => {
    const pull = repo.pulls.find((candidate) => candidate.number === Number(args.number));
    return pull === undefined ? null : { repo, pull };
  }),
  pullRequests: field(object('PullRequestConnection'), (repo, args) => {
    const page = pullPage(repo, args);
    return { repo, nodes: page.nodes.map((pull) => ({ repo, pull })), totalCount: page.totalCount, pageInfo: page.pageInfo };
  }),
  ref: field(object('Ref'), (repo, args) => {
    const oid = repo.refs.get(args.qualifiedName);
    return oid === undefined ? null : { name: String(args.qualifiedName).replace(/^refs\/heads\//, ''), repository: repo };
  }),
});

defineType('Ref', 'OBJECT', {
  name: field(scalar(), (value) => value.name),
  prefix: field(scalar(), () => 'refs/heads/'),
  target: field(object('Commit'), (value) => {
    const oid = value.repository.refs.get(`refs/heads/${value.name}`) ?? value.repository.refs.get(value.name);
    return oid === undefined ? null : { oid };
  }),
});

defineType('Commit', 'OBJECT', {
  oid: field(scalar(), (value) => value.oid),
  abbreviatedOid: field(scalar(), (value) => String(value.oid).slice(0, 7)),
  message: field(scalar(), (value) => value.message ?? ''),
});

defineType('Issue', 'OBJECT', {
  id: field(scalar(), (value) => globalId('Issue', [value.repo.id, value.issue.number])),
  number: field(scalar(), (value) => value.issue.number),
  title: field(scalar(), (value) => value.issue.title),
  state: field(scalar(), (value) => issueStateName(value.issue)),
  stateReason: field(scalar(), (value) => (value.issue.state === 'closed' ? 'COMPLETED' : null)),
  body: field(scalar(), (value) => value.issue.body),
  createdAt: field(scalar(), (value) => value.issue.createdAt),
  updatedAt: field(scalar(), (value) => value.issue.updatedAt),
  closedAt: field(scalar(), (value) => value.issue.closedAt),
  url: field(scalar(), (value) => `https://forge.example.invalid/${value.repo.fullName}/issues/${value.issue.number}`),
  author: field(object('User'), (value) => ({ login: value.issue.author })),
  comments: field(object('IssueCommentConnection'), (value) => {
    const comments = value.repo.comments.get(value.issue.number) ?? [];
    return { totalCount: comments.length, nodes: comments.map((comment) => ({ comment })) };
  }),
});

defineType('IssueConnection', 'OBJECT', {
  nodes: field(listOf('Issue'), (value) => value.nodes),
  totalCount: field(scalar(), (value) => value.totalCount),
  pageInfo: field(object('PageInfo'), (value) => value.pageInfo),
});

defineType('IssueCommentConnection', 'OBJECT', {
  nodes: field(listOf('IssueComment'), (value) => value.nodes),
  totalCount: field(scalar(), (value) => value.totalCount),
});

defineType('IssueComment', 'OBJECT', {
  id: field(scalar(), (value) => globalId('IssueComment', [value.comment.id])),
  body: field(scalar(), (value) => value.comment.body),
  createdAt: field(scalar(), (value) => value.comment.createdAt),
  author: field(object('User'), (value) => ({ login: value.comment.author })),
});

defineType('PageInfo', 'OBJECT', {
  hasNextPage: field(scalar(), (page) => page.hasNextPage),
  hasPreviousPage: field(scalar(), (page) => page.hasPreviousPage),
  startCursor: field(scalar(), (page) => page.startCursor),
  endCursor: field(scalar(), (page) => page.endCursor),
});

defineType('PullRequest', 'OBJECT', {
  id: field(scalar(), (value) => globalId('PullRequest', [value.repo.id, value.pull.number])),
  number: field(scalar(), (value) => value.pull.number),
  title: field(scalar(), (value) => value.pull.title),
  body: field(scalar(), (value) => value.pull.body),
  state: field(scalar(), (value) => pullStateName(value.pull)),
  merged: field(scalar(), (value) => value.pull.merged === true),
  mergedAt: field(scalar(), (value) => value.pull.mergedAt),
  isDraft: field(scalar(), () => false),
  headRefName: field(scalar(), (value) => value.pull.head),
  baseRefName: field(scalar(), (value) => value.pull.base),
  mergeable: field(scalar(), (value) => (pullConflict(value.repo, value.pull) ? 'CONFLICTING' : 'MERGEABLE')),
  createdAt: field(scalar(), (value) => value.pull.createdAt),
  updatedAt: field(scalar(), (value) => value.pull.updatedAt),
  url: field(scalar(), (value) => `https://forge.example.invalid/${value.repo.fullName}/pull/${value.pull.number}`),
  author: field(object('User'), (value) => ({ login: value.pull.author })),
  files: field(object('PullRequestChangedFileConnection'), (value, args) => {
    const first = typeof args.first === 'number' && args.first > 0 ? args.first : 100;
    const changes = pullFiles(value.repo, value.pull).slice(0, first);
    return { nodes: changes.map((change) => ({ change })), totalCount: changes.length };
  }),
  mergeCommit: field(object('Commit'), (value) => (value.pull.mergeCommitSha === null ? null : { oid: value.pull.mergeCommitSha })),
  headRef: field(object('Ref'), (value) => ({ name: value.pull.head, repository: value.repo })),
  baseRef: field(object('Ref'), (value) => ({ name: value.pull.base, repository: value.repo })),
});

defineType('PullRequestChangedFileConnection', 'OBJECT', {
  nodes: field(listOf('PullRequestChangedFile'), (value) => value.nodes),
  totalCount: field(scalar(), (value) => value.totalCount),
});

defineType('PullRequestChangedFile', 'OBJECT', {
  path: field(scalar(), (value) => value.change.path),
  additions: field(scalar(), (value) => value.change.additions),
  deletions: field(scalar(), (value) => value.change.deletions),
  changeType: field(scalar(), (value) => (value.change.status === 'added' ? 'ADDED' : value.change.status === 'removed' ? 'DELETED' : 'MODIFIED')),
});

defineType('PullRequestConnection', 'OBJECT', {
  nodes: field(listOf('PullRequest'), (value) => value.nodes),
  totalCount: field(scalar(), (value) => value.totalCount),
  pageInfo: field(object('PageInfo'), (value) => value.pageInfo),
});

defineType('Node', 'OBJECT', { id: field(scalar(), () => null) });

// ---------------------------------------------------------------- mutations

defineType('Mutation', 'OBJECT', {
  createIssue: field(object('CreateIssuePayload'), (value, args, ctx) => {
    const input = args.input ?? {};
    const parsed = parseGlobalId(input.repositoryId);
    const repo = parsed === null ? null : repoById(ctx.forge, parsed.parts[0]);
    if (repo === null) throw new Error('the repository does not exist');
    const issue = createIssueAction(ctx.forge, repo, { title: input.title, body: input.body });
    return { issue: { repo, issue } };
  }),
  closeIssue: field(object('CloseIssuePayload'), (value, args, ctx) => {
    const parsed = parseGlobalId((args.input ?? {}).issueId);
    if (parsed === null || parsed.kind !== 'Issue') throw new Error('the issue id is not an issue');
    const repo = repoById(ctx.forge, parsed.parts[0]);
    const issue = repo === null ? undefined : repo.issues.find((candidate) => String(candidate.number) === String(parsed.parts[1]));
    if (issue === undefined) throw new Error('the issue does not exist');
    setIssueStateAction(ctx.forge, repo, issue, 'closed');
    return { issue: { repo, issue } };
  }),
  createPullRequest: field(object('CreatePullRequestPayload'), (value, args, ctx) => {
    const input = args.input ?? {};
    const parsed = parseGlobalId(input.repositoryId);
    const repo = parsed === null ? null : repoById(ctx.forge, parsed.parts[0]);
    if (repo === null) throw new Error('the repository does not exist');
    const pull = createPullAction(ctx.forge, repo, {
      title: input.title,
      body: input.body,
      head: input.headRefName,
      base: input.baseRefName,
    });
    return { pullRequest: { repo, pull } };
  }),
  mergePullRequest: field(object('MergePullRequestPayload'), (value, args, ctx) => {
    const parsed = parseGlobalId((args.input ?? {}).pullRequestId);
    if (parsed === null || parsed.kind !== 'PullRequest') throw new Error('the pull request id is not a pull request');
    const repo = repoById(ctx.forge, parsed.parts[0]);
    const pull = repo === null ? undefined : repo.pulls.find((candidate) => String(candidate.number) === String(parsed.parts[1]));
    if (pull === undefined) throw new Error('the pull request does not exist');
    mergePullAction(ctx.forge, repo, pull, (args.input ?? {}).mergeMethod ?? 'SQUASH');
    return { pullRequest: { repo, pull } };
  }),
  addComment: field(object('AddCommentPayload'), (value, args, ctx) => {
    const parsed = parseGlobalId((args.input ?? {}).subjectId);
    if (parsed === null || parsed.kind !== 'Issue') throw new Error('the subject id is not an issue');
    const repo = repoById(ctx.forge, parsed.parts[0]);
    const issue = repo === null ? undefined : repo.issues.find((candidate) => String(candidate.number) === String(parsed.parts[1]));
    if (issue === undefined) throw new Error('the issue does not exist');
    const comment = addCommentAction(ctx.forge, repo, issue, (args.input ?? {}).body);
    return { commentEdge: { node: { comment } } };
  }),
});

defineType('CreateIssuePayload', 'OBJECT', { issue: field(object('Issue'), (value) => value.issue) });
defineType('CloseIssuePayload', 'OBJECT', { issue: field(object('Issue'), (value) => value.issue) });
defineType('CreatePullRequestPayload', 'OBJECT', { pullRequest: field(object('PullRequest'), (value) => value.pullRequest) });
defineType('MergePullRequestPayload', 'OBJECT', { pullRequest: field(object('PullRequest'), (value) => value.pullRequest) });
defineType('AddCommentPayload', 'OBJECT', { commentEdge: field(object('IssueCommentEdge'), (value) => value.commentEdge) });
defineType('IssueCommentEdge', 'OBJECT', { node: field(object('IssueComment'), (value) => value.node) });

// ---------------------------------------------------------------- introspection

/** The fields and enum values the `__type` probe reports, keyed by type name. */
const ENUM_TYPES = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

function typeInfo(name) {
  if (typeof name !== 'string') return null;
  if (ENUM_TYPES[name] !== undefined) {
    return {
      kind: 'ENUM',
      name,
      description: `${name} values`,
      fields: null,
      enumValues: ENUM_TYPES[name].map((value) => ({ name: value, description: null, isDeprecated: false, deprecationReason: null })),
    };
  }
  const type = TYPES[name];
  if (type === undefined) return null;
  return {
    kind: type.kind,
    name,
    description: `${name} type`,
    fields: Object.entries(type.fields).map(([fieldName, definition]) => ({
      name: fieldName,
      description: `${fieldName} of ${name}`,
      isDeprecated: false,
      deprecationReason: null,
      type: { kind: 'SCALAR', name: 'String', ofType: null },
      args: [],
    })),
    enumValues: null,
  };
}

defineType('__Type', 'OBJECT', {
  kind: field(scalar(), (value) => value.kind),
  name: field(scalar(), (value) => value.name),
  description: field(scalar(), (value) => value.description),
  fields: field(listOf('__Field'), (value) => value.fields ?? []),
  enumValues: field(listOf('__EnumValue'), (value) => value.enumValues ?? []),
  ofType: field(object('__Type'), () => null),
});

defineType('__Field', 'OBJECT', {
  name: field(scalar(), (value) => value.name),
  description: field(scalar(), (value) => value.description),
  isDeprecated: field(scalar(), (value) => value.isDeprecated),
  deprecationReason: field(scalar(), (value) => value.deprecationReason),
  type: field(object('__Type'), (value) => value.type),
  args: field(listOf('__InputValue'), (value) => value.args ?? []),
});

defineType('__EnumValue', 'OBJECT', {
  name: field(scalar(), (value) => value.name),
  description: field(scalar(), (value) => value.description),
  isDeprecated: field(scalar(), (value) => value.isDeprecated),
  deprecationReason: field(scalar(), (value) => value.deprecationReason),
});

defineType('__InputValue', 'OBJECT', {
  name: field(scalar(), (value) => value.name),
  description: field(scalar(), (value) => value.description),
  defaultValue: field(scalar(), (value) => value.defaultValue ?? null),
  type: field(object('__Type'), (value) => value.type ?? null),
});

defineType('__Schema', 'OBJECT', {
  queryType: field(object('__Type'), (value) => value.queryType),
  mutationType: field(object('__Type'), (value) => value.mutationType),
  types: field(listOf('__Type'), (value) => value.types),
});

// ---------------------------------------------------------------- execution

/** Evaluate one argument value against the request's variables. */
function evalValue(ctx, node) {
  switch (node.kind) {
    case 'variable': {
      const value = ctx.variables[node.name];
      if (value !== undefined) return value;
      const def = ctx.defaults.get(node.name);
      if (def !== undefined) return evalValue(ctx, def);
      return null;
    }
    case 'literal':
      return node.value;
    case 'list':
      return node.items.map((item) => evalValue(ctx, item));
    case 'object': {
      const out = {};
      for (const [name, value] of node.entries) out[name] = evalValue(ctx, value);
      return out;
    }
    default:
      return null;
  }
}

function evalArgs(ctx, args) {
  const out = {};
  for (const [name, value] of args ?? []) out[name] = evalValue(ctx, value);
  return out;
}

/** Complete one field's value for its declared type, recursing into object selections. */
function completeValue(ctx, type, raw, selections) {
  if (type.kind === 'list') {
    if (raw === null || raw === undefined) return null;
    return raw.map((item) => completeValue(ctx, type.of, item, selections));
  }
  if (type.kind === 'scalar') return raw === undefined ? null : raw;
  const definition = TYPES[type.name];
  if (definition === undefined || definition.kind === 'ENUM') return raw === undefined ? null : raw;
  if (raw === null || raw === undefined) return null;
  const wrapped = raw.__type === undefined ? { __type: type.name, value: raw } : raw;
  return executeSelection(ctx, wrapped.__type, wrapped.value, selections ?? []);
}

/** Resolve one selection set against one object. */
function executeSelection(ctx, typeName, value, selections) {
  const out = {};
  for (const selection of selections ?? []) {
    if (selection.kind === 'inlineFragment') {
      if (selection.typeCondition === null || selection.typeCondition === typeName) {
        Object.assign(out, executeSelection(ctx, typeName, value, selection.selections));
      }
      continue;
    }
    if (selection.kind === 'fragment') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment !== undefined && (fragment.typeCondition === null || fragment.typeCondition === typeName)) {
        Object.assign(out, executeSelection(ctx, typeName, value, fragment.selections));
      }
      continue;
    }
    const type = TYPES[typeName];
    const definition = type === undefined ? undefined : type.fields[selection.name];
    const key = selection.alias ?? selection.name;
    if (definition === undefined) {
      ctx.errors.push({ message: `Field '${selection.name}' doesn't exist on type '${typeName}'`, path: [key] });
      continue;
    }
    let args;
    try {
      args = evalArgs(ctx, selection.args);
    } catch (error) {
      ctx.errors.push({ message: String(error.message) });
      continue;
    }
    try {
      const raw = definition.resolve(value, args, ctx);
      out[key] = completeValue(ctx, definition.type, raw, selection.selections);
    } catch (error) {
      ctx.errors.push({ message: error instanceof ActionError ? error.message : String(error.message ?? error), path: [key] });
      out[key] = null;
    }
  }
  return out;
}

/** Run one operation document and answer its {data, errors} envelope. */
function runOperation(forge, payload) {
  const query = typeof payload.query === 'string' ? payload.query : '';
  const variables = typeof payload.variables === 'object' && payload.variables !== null ? payload.variables : {};
  let document;
  try {
    document = parseDocument(query);
  } catch (error) {
    return { errors: [{ message: `syntax error: ${error.message}` }] };
  }
  if (document.operations.length === 0) return { errors: [{ message: 'the document holds no operation' }] };
  const wanted = typeof payload.operationName === 'string' ? payload.operationName : null;
  const operation = wanted === null ? document.operations[0] : document.operations.find((candidate) => candidate.name === wanted);
  if (operation === undefined) return { errors: [{ message: `no operation named ${wanted}` }] };
  const defaults = new Map();
  for (const definition of operation.variableDefs) if (definition.default !== undefined) defaults.set(definition.name, definition.default);
  const ctx = { forge, variables, defaults, fragments: document.fragments, errors: [] };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelection(ctx, rootType, null, operation.selections);
  return ctx.errors.length > 0 ? { data, errors: ctx.errors } : { data };
}

// ---------------------------------------------------------------- the HTTP edge

export async function handleGraphQL(forge, req, res) {
  const raw = await readBody(req, 4 * 1024 * 1024);
  if (raw === null) {
    sendJson(res, 413, { errors: [{ message: 'request body too large' }] });
    return;
  }
  let body;
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] });
    return;
  }
  if (Array.isArray(body)) {
    sendJson(res, 200, body.map((entry) => runOperation(forge, entry ?? {})));
    return;
  }
  if (typeof body !== 'object' || body === null || typeof body.query !== 'string') {
    sendJson(res, 400, { errors: [{ message: 'a query is required' }] });
    return;
  }
  sendJson(res, 200, runOperation(forge, body));
}
