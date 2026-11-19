// @ts-nocheck — the runtime strips types; there is no type-checking step in the trial pod.
// The forge's store: the one place the repositories, refs, objects, issues, labels, comments and
// pull requests live. In memory for the life of the process, which is the life of one trial — the
// rules allow it and every read then costs no I/O.
//
// The store also owns the git model built on gitproto.ts: object reads and writes, trees, commits,
// ancestry, diffs and the squash merge. Nothing here reads a clock or a random source: ids are
// counters and every timestamp comes from tick(), so two runs of the same requests build the same
// objects byte for byte.

import { buildCommit, buildTree, hashObject, isObjectId, parseCommit, parseTag, parseTree, ZERO_OID } from './gitproto.ts';

/**
 * The login the trial's bearer token names. The suite builds its scenario from one fixed seed
 * (wire.ts SCENARIO_SEED, its 'users' stream), so the token's owner is the same login in every
 * trial: its first generated user. MAKEFUN_FORGE_LOGIN overrides it for a hand-run server.
 */
export const DEFAULT_LOGIN = process.env.MAKEFUN_FORGE_LOGIN ?? 'adaiversen';

/** The user record the token's login resolves to. */
export function viewerUser(login) {
  return { login, id: 1000, name: login, email: `${login}@example.invalid` };
}

/** One repository: its git store (objects, refs, HEAD) and its issue-tracker state. */
export class Repo {
  constructor(id, owner, name, options) {
    this.id = id;
    this.owner = owner;
    this.name = name;
    this.description = (options && options.description) || '';
    this.private = Boolean(options && options.private);
    this.defaultBranch = 'main';
    this.createdAt = (options && options.createdAt) || '';
    this.objects = new Map();
    this.refs = new Map();
    this.head = 'refs/heads/main';
    this.issues = [];
    this.issueCounter = 0;
    this.labels = new Map();
    this.pulls = [];
    this.pullCounter = 0;
    this.comments = new Map();
    this.commentCounter = 0;
    this.ancestorCache = new Map();
  }

  get fullName() {
    return `${this.owner}/${this.name}`;
  }
}

/** The forge: every repository, keyed by owner and name case-insensitively. */
export class Forge {
  constructor() {
    this.repos = new Map();
    this.login = DEFAULT_LOGIN;
    this.nextRepoId = 1;
    this.nextIssueId = 1000;
    this.nextCommentId = 5000;
    this.nextPullId = 2000;
    this.clock = 1735689600;
    this.requestCounter = 0;
  }

  /** A deterministic wall clock: the trial's data never depends on the machine's time. */
  tick(step) {
    this.clock += step === undefined ? 60 : step;
    return new Date(this.clock * 1000).toISOString();
  }

  key(owner, name) {
    return `${String(owner).toLowerCase()}/${String(name).toLowerCase()}`;
  }

  /** The repository at owner/name, or null. A repo belongs to the login that owns it. */
  repo(owner, name) {
    return this.repos.get(this.key(owner, name)) ?? null;
  }

  /** Create a repository (the REST creation path). Existing names are refused by the caller. */
  createRepo(owner, name, options) {
    const repo = new Repo(this.nextRepoId++, owner, name, { ...options, createdAt: this.tick() });
    this.repos.set(this.key(owner, name), repo);
    return repo;
  }

  deleteRepo(repo) {
    this.repos.delete(this.key(repo.owner, repo.name));
  }

  /** Every repository `owner` holds, oldest first. */
  reposOf(owner) {
    const lower = String(owner).toLowerCase();
    const out = [];
    for (const repo of this.repos.values()) if (repo.owner.toLowerCase() === lower) out.push(repo);
    return out.sort((a, b) => a.id - b.id);
  }
}

// ---------------------------------------------------------------- objects

/** Store one object and answer its id. */
export function putObject(repo, type, data) {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

/** Store one object whose id the caller already computed (a pack's own hash); answers the id. */
export function putObjectKnown(repo, oid, type, data) {
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

/** The object with id `oid`, or null. */
export function getObject(repo, oid) {
  return repo.objects.get(oid) ?? null;
}

/** A blob's bytes at `oid`, or null when the object is absent or not a blob. */
export function getBlob(repo, oid) {
  const object = repo.objects.get(oid);
  return object !== undefined && object.type === 'blob' ? object.data : null;
}

/**
 * A commit's parsed view, or null when the object is absent or not a commit. An object's bytes
 * never change once stored, and neither does their parse: the first reader parses, every later
 * reader gets the same structure back.
 */
export function getCommit(repo, oid) {
  const object = repo.objects.get(oid);
  if (object === undefined || object.type !== 'commit') return null;
  return object.commit ?? (object.commit = parseCommit(object.data));
}

/** The tree entries of a tree object, in stored order (parsed once, like getCommit). */
export function treeEntries(repo, treeOid) {
  const object = repo.objects.get(treeOid);
  if (object === undefined || object.type !== 'tree') return [];
  return object.entries ?? (object.entries = parseTree(object.data));
}

// ---------------------------------------------------------------- refs

/** The tip `refName` points at, or null. A tag is peeled to the commit it names. */
export function refTip(repo, refName) {
  const oid = repo.refs.get(refName);
  return oid === undefined ? null : oid;
}

/**
 * Resolve a revision the way the API's `sha` and `ref` parameters do: a full object id, a branch
 * name, a tag name, `refs/...`, or HEAD.
 */
export function resolveRevision(repo, revision) {
  if (typeof revision !== 'string' || revision === '') return null;
  if (isObjectId(revision)) return repo.objects.has(revision) ? revision : null;
  if (revision === 'HEAD') return refTip(repo, repo.head);
  const candidates = [revision, `refs/heads/${revision}`, `refs/tags/${revision}`, `refs/${revision}`];
  for (const candidate of candidates) {
    const tip = repo.refs.get(candidate);
    if (tip !== undefined) return peel(repo, tip);
  }
  return null;
}

/** A tag object's target, followed until a non-tag object. */
export function peel(repo, oid) {
  let current = oid;
  for (let depth = 0; depth < 8; depth += 1) {
    const object = repo.objects.get(current);
    if (object === undefined || object.type !== 'tag') return current;
    current = parseTag(object.data).object;
  }
  return current;
}

// ---------------------------------------------------------------- ancestry

/**
 * Every commit reachable from `tip` (the tip included). A commit's ancestry never changes, so the
 * sets are cached for the life of the process and a new tip costs one step over its parent's set:
 * the push workload's 200 sequential commits do not walk the history again per push.
 */
export function ancestorsOf(repo, tip) {
  const cached = repo.ancestorCache.get(tip);
  if (cached !== undefined) return cached;
  const seen = new Set();
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop();
    if (seen.has(oid)) continue;
    const known = repo.ancestorCache.get(oid);
    if (known !== undefined) {
      for (const oid2 of known) seen.add(oid2);
      continue;
    }
    seen.add(oid);
    const commit = getCommit(repo, oid);
    if (commit === null) continue;
    for (const parent of commit.parents) if (!seen.has(parent)) stack.push(parent);
  }
  repo.ancestorCache.set(tip, seen);
  return seen;
}

/** Whether `ancestor` is `descendant` or one of its ancestors: the fast-forward test. */
export function isAncestor(repo, ancestor, descendant) {
  if (ancestor === descendant) return true;
  const commit = getCommit(repo, descendant);
  if (commit !== null && commit.parents.includes(ancestor)) return true;
  return ancestorsOf(repo, descendant).has(ancestor);
}

/** The log from `tip`, newest generation first (breadth-first over parents). */
export function commitLog(repo, tip, limit) {
  const out = [];
  const seen = new Set();
  const queue = [tip];
  while (queue.length > 0 && (limit === undefined || out.length < limit)) {
    const oid = queue.shift();
    if (seen.has(oid)) continue;
    seen.add(oid);
    const commit = getCommit(repo, oid);
    if (commit === null) continue;
    out.push({ oid, commit });
    for (const parent of commit.parents) queue.push(parent);
  }
  return out;
}

/** The best common ancestor of two commits: the first one met walking a's ancestry. */
export function mergeBase(repo, a, b) {
  if (a === null || b === null) return null;
  const bAncestors = ancestorsOf(repo, b);
  for (const candidate of ancestorsOf(repo, a)) if (bAncestors.has(candidate)) return candidate;
  return null;
}

// ---------------------------------------------------------------- trees

/** One path in a tree: its mode and object id. */
export function pathEntry(repo, treeOid, segments) {
  let entries = treeEntries(repo, treeOid);
  for (let index = 0; index < segments.length; index += 1) {
    const name = segments[index];
    const entry = entries.find((candidate) => candidate.name === name);
    if (entry === undefined) return null;
    if (index === segments.length - 1) return entry;
    if (entry.mode !== '40000') return null;
    entries = treeEntries(repo, entry.oid);
  }
  return null;
}

/**
 * A tree with `segments` set to `file` ({mode, oid}) or, when `file` is null, removed. Answers the
 * new tree's id, or null when the tree is left empty (the last file of a directory removed).
 */
export function treeSetPath(repo, entries, segments, file) {
  const head = segments[0];
  if (head === undefined || head === '' || head === '.' || head === '..') throw new Error('unusable path segment');
  const rest = segments.slice(1);
  const kept = entries.filter((entry) => entry.name !== head);
  if (rest.length === 0) {
    if (file !== null) kept.push({ mode: file.mode, name: head, oid: file.oid });
  } else {
    const existing = entries.find((entry) => entry.name === head && entry.mode === '40000');
    const childEntries = existing === undefined ? [] : treeEntries(repo, existing.oid);
    const childOid = treeSetPath(repo, childEntries, rest, file);
    if (childOid !== null) kept.push({ mode: '40000', name: head, oid: childOid });
  }
  if (kept.length === 0) return null;
  return putObject(repo, 'tree', buildTree(kept));
}

/** Every path under `treeOid` as a map of path to {mode, oid}; gitlinks are skipped. */
export function flattenTree(repo, treeOid, prefix, into) {
  const out = into ?? new Map();
  for (const entry of treeEntries(repo, treeOid)) {
    const path = prefix === undefined || prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(repo, entry.oid, path, out);
    else if (entry.mode !== '160000') out.set(path, { mode: entry.mode, oid: entry.oid });
  }
  return out;
}

/** The tree a commit holds, or null. */
export function commitTree(repo, commitOid) {
  const commit = getCommit(repo, commitOid);
  return commit === null ? null : commit.tree;
}

// ---------------------------------------------------------------- writing commits

/** Build a commit object and store it. */
export function writeCommit(repo, { tree, parents, message, author, timestamp }) {
  const data = buildCommit({ tree, parents, message, author, timestamp });
  return putObject(repo, 'commit', data);
}

/**
 * Write one file into a commit's tree: `path` is `a/b/c`, `file` is {mode, oid} or null to delete.
 * Answers {tree, blob} where tree is the new root tree id (null when the commit becomes empty).
 */
export function writeFileInTree(repo, baseTreeOid, path, file) {
  const segments = path.split('/').filter((segment) => segment !== '');
  if (segments.length === 0) throw new Error('an empty contents path');
  const entries = baseTreeOid === null ? [] : treeEntries(repo, baseTreeOid);
  return treeSetPath(repo, entries, segments, file);
}

// ---------------------------------------------------------------- diffs

/** A line-multiset count of what one text adds and removes against another. */
export function lineDelta(baseText, headText) {
  if (baseText === headText) return { additions: 0, deletions: 0 };
  const baseLines = baseText === '' ? [] : baseText.split('\n');
  const headLines = headText === '' ? [] : headText.split('\n');
  const counts = new Map();
  for (const line of baseLines) counts.set(line, (counts.get(line) ?? 0) + 1);
  let additions = 0;
  for (const line of headLines) {
    const left = counts.get(line) ?? 0;
    if (left > 0) counts.set(line, left - 1);
    else additions += 1;
  }
  let deletions = 0;
  for (const left of counts.values()) deletions += left;
  return { additions, deletions };
}

/** The changed paths between two trees: [{path, status, additions, deletions, baseOid, headOid}]. */
export function diffTrees(repo, baseTreeOid, headTreeOid) {
  const base = baseTreeOid === null ? new Map() : flattenTree(repo, baseTreeOid);
  const head = headTreeOid === null ? new Map() : flattenTree(repo, headTreeOid);
  const paths = new Set([...base.keys(), ...head.keys()]);
  const out = [];
  for (const path of [...paths].sort()) {
    const before = base.get(path);
    const after = head.get(path);
    if (before !== undefined && after !== undefined && before.oid === after.oid && before.mode === after.mode) continue;
    const status = before === undefined ? 'added' : after === undefined ? 'removed' : 'modified';
    const beforeText = before === undefined ? '' : (getBlob(repo, before.oid) ?? Buffer.alloc(0)).toString('utf8');
    const afterText = after === undefined ? '' : (getBlob(repo, after.oid) ?? Buffer.alloc(0)).toString('utf8');
    const counts = lineDelta(beforeText, afterText);
    out.push({
      path,
      status,
      additions: status === 'removed' ? 0 : Math.max(counts.additions, status === 'added' ? Math.max(1, afterText.split('\n').length) : 0),
      deletions: status === 'added' ? 0 : counts.deletions,
      baseOid: before === undefined ? null : before.oid,
      headOid: after === undefined ? null : after.oid,
    });
  }
  return out;
}

// ---------------------------------------------------------------- object closure

/**
 * Every object reachable from `roots`, parents and tags followed, with the gitlink entries skipped.
 * `stop` (optional) is a predicate: return true for an object whose edges are not followed.
 */
export function reachableObjects(repo, roots, stop) {
  const seen = new Set();
  const queue = [...roots];
  while (queue.length > 0) {
    const oid = queue.pop();
    if (seen.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object === undefined) continue;
    seen.add(oid);
    if (stop !== undefined && stop(oid) === true) continue;
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) if (entry.mode !== '160000') queue.push(entry.oid);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    }
  }
  return seen;
}

/** The zero id, re-exported so callers need no second import for the unborn-branch case. */
export { ZERO_OID };
