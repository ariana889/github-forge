// @ts-nocheck — the runtime strips types; there is no type-checking step in the trial pod.
// The git side of the forge: the smart-HTTP protocol, spoken from the store in forge.ts.
//
//   GET  /{owner}/{repo}.git/info/refs?service=git-upload-pack   protocol v2 (or v0) advertisement
//   GET  /{owner}/{repo}.git/info/refs?service=git-receive-pack  the v0 push advertisement
//   POST /{owner}/{repo}.git/git-upload-pack                     v2 ls-refs / fetch, and v0 fetch
//   POST /{owner}/{repo}.git/git-receive-pack                    v0 receive-pack: commands + pack
//
// The v2 side serves ls-refs (with ref-prefix, symrefs, peel and unborn) and fetch (with shallow
// depth, deepen and have/want negotiation), framed the way protocol v2 frames it: section headers,
// a sideband packfile. The v0 side serves a plain ref advertisement and a want/have/done fetch, and
// receive-pack answers report-status inside side-band-64k when the client asks for it.
//
// Nothing is buffered that the client would stream: a fetch response is one buffer of sideband
// frames written when the pack is complete, and the pack itself is cached for the shallow-clone
// workload, where fifty clients ask for the same three objects.

import {
  ZERO_OID,
  decodePktLines,
  encodePktLines,
  pktFlush,
  pktLine,
  readPack,
  sidebandStream,
  writePack,
} from './gitproto.ts';
import {
  ancestorsOf,
  commitTree,
  getCommit,
  isAncestor,
  peel,
  putObject,
  putObjectKnown,
  refTip,
  resolveRevision,
  treeEntries,
} from './forge.ts';
import { readBody, sendBytes, sendJson } from './http.ts';

const AGENT = 'makefun-forge/1.0';

const UPLOAD_ADVERT = 'application/x-git-upload-pack-advertisement';
const UPLOAD_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_ADVERT = 'application/x-git-receive-pack-advertisement';
const RECEIVE_RESULT = 'application/x-git-receive-pack-result';

/** The capabilities a v0 upload-pack advertises: enough for any client, no filtering. */
const UPLOAD_V0_CAPS = `multi_ack_detailed side-band-64k thin-pack ofs-delta shallow deepen-since deepen-not no-progress agent=${AGENT}`;

/** The capabilities receive-pack advertises: the three the rules name, plus ofs-delta and agent. */
const RECEIVE_V0_CAPS = `report-status delete-refs side-band-64k ofs-delta agent=${AGENT}`;

/** One repository's refs sorted the way git lists them (HEAD first, then by name). */
function sortedRefs(repo) {
  return [...repo.refs.keys()].sort();
}

/** Whether a ref names an annotated tag object (a tag's ref may be updated freely). */
function tagRefName(name) {
  return name.startsWith('refs/tags/');
}

/** The lines of a v0 ref advertisement for `repo`. */
function v0AdvertLines(repo, capabilities) {
  const refs = sortedRefs(repo);
  const headTip = refTip(repo, repo.head);
  const lines = [];
  let first = true;
  const push = (oid, name) => {
    const caps = first ? `\u0000${capabilities} symref=HEAD:${repo.head}` : '';
    first = false;
    lines.push(`${oid} ${name}${caps}\n`);
  };
  if (headTip !== null) push(headTip, 'HEAD');
  for (const name of refs) {
    const oid = repo.refs.get(name);
    if (oid === undefined) continue;
    push(oid, name);
    const object = repo.objects.get(oid);
    if (object !== undefined && object.type === 'tag') lines.push(`${peel(repo, oid)} ${name}^{}\n`);
  }
  if (first) lines.push(`${ZERO_OID} capabilities^{}\u0000${capabilities}\n`);
  return lines;
}

/** The v2 capability advertisement's lines. */
function v2CapabilityLines() {
  return [`version 2\n`, `agent=${AGENT}\n`, 'ls-refs=unborn\n', 'fetch=shallow\n', 'object-format=sha1\n'];
}

/** Whether the request asked for protocol v2. */
function wantsV2(req) {
  const header = req.headers['git-protocol'];
  const text = Array.isArray(header) ? header.join(' ') : header;
  return typeof text === 'string' && /version\s*=\s*2/.test(text);
}

/** The v2 advertisement body, built once: its capabilities never change. */
let v2AdvertBody = null;

/** The ref advertisement: v2 capabilities for upload-pack, a v0 ref list otherwise. */
function advertise(req, res, repo, service, v2) {
  if (v2) {
    if (v2AdvertBody === null) {
      v2AdvertBody = Buffer.concat([pktLine(`# service=${service}\n`), pktFlush(), encodePktLines([...v2CapabilityLines(), 'flush'])]);
    }
    sendBytes(res, 200, UPLOAD_ADVERT, v2AdvertBody);
    return;
  }
  const preamble = pktLine(`# service=${service}\n`);
  const caps = service === 'git-receive-pack' ? RECEIVE_V0_CAPS : UPLOAD_V0_CAPS;
  const body = Buffer.concat([preamble, pktFlush(), encodePktLines([...v0AdvertLines(repo, caps), 'flush'])]);
  sendBytes(res, 200, service === 'git-receive-pack' ? RECEIVE_ADVERT : UPLOAD_ADVERT, body);
}

// ---------------------------------------------------------------- v2 ls-refs

/** The refs one ls-refs request asks for, filtered by its ref-prefix arguments. */
function lsRefsBody(repo, args) {
  const prefixes = args.filter((argument) => argument.startsWith('ref-prefix ')).map((argument) => argument.slice(11).trim());
  const peelWanted = args.includes('peel');
  const symrefsWanted = args.includes('symrefs');
  const unbornWanted = args.includes('unborn');
  const keep = (name) => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const lines = [];
  const headTip = refTip(repo, repo.head);
  if (keep('HEAD')) {
    if (headTip !== null) {
      let line = `${headTip} HEAD`;
      if (symrefsWanted) line += ` symref-target:${repo.head}`;
      lines.push(`${line}\n`);
    } else if (unbornWanted) {
      lines.push(symrefsWanted ? `unborn HEAD symref-target:${repo.head}\n` : 'unborn HEAD\n');
    }
  }
  for (const name of sortedRefs(repo)) {
    if (!keep(name)) continue;
    const oid = repo.refs.get(name);
    let line = `${oid} ${name}`;
    if (peelWanted) {
      const object = repo.objects.get(oid);
      if (object !== undefined && object.type === 'tag') line += ` peeled:${peel(repo, oid)}`;
    }
    lines.push(`${line}\n`);
  }
  return encodePktLines([...lines, 'flush']);
}

// ---------------------------------------------------------------- the object walk

/** Every object a client holding `haves` already has, with the client's shallow cuts respected. */
function haveClosure(repo, haves, clientShallow) {
  const seen = new Set();
  const queue = [];
  for (const have of haves) if (repo.objects.has(have)) queue.push(have);
  while (queue.length > 0) {
    const oid = queue.pop();
    if (seen.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object === undefined) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = getCommit(repo, oid);
      if (commit === null) continue;
      queue.push(commit.tree);
      if (!clientShallow.has(oid)) for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tree') {
      for (const entry of treeEntries(repo, oid)) if (entry.mode !== '160000') queue.push(entry.oid);
    } else if (object.type === 'tag') {
      queue.push(peel(repo, oid));
    }
  }
  return seen;
}

/** The commits a depth-limited walk from the wants reaches, and the ones its depth cut. */
function shallowCommits(repo, wants, depth) {
  const level = new Map();
  const queue = [];
  for (const want of wants) {
    const oid = peel(repo, want);
    if (getCommit(repo, oid) !== null && !level.has(oid)) {
      level.set(oid, 1);
      queue.push(oid);
    }
  }
  const commits = new Set();
  const boundary = new Set();
  while (queue.length > 0) {
    const oid = queue.shift();
    if (commits.has(oid)) continue;
    commits.add(oid);
    const commit = getCommit(repo, oid);
    if (commit === null) continue;
    const current = level.get(oid) ?? 1;
    if (current >= depth) {
      boundary.add(oid);
      continue;
    }
    for (const parent of commit.parents) {
      if (!level.has(parent)) {
        level.set(parent, current + 1);
        queue.push(parent);
      }
    }
  }
  return { commits, boundary };
}

/**
 * The objects a fetch must send: everything reachable from the wants that the client's haves do not
 * already reach, with `depth` cutting the history and `clientShallow` marking where the client's own
 * history stops. Answers {objects, shallow, unshallow}: the new boundaries to announce and the old
 * ones the deeper history removes.
 */
function fetchObjects(repo, wants, haves, depth, clientShallow) {
  const have = haveClosure(repo, haves, clientShallow);
  const objects = new Map();
  const addTree = (treeOid) => {
    const queue = [treeOid];
    while (queue.length > 0) {
      const oid = queue.pop();
      if (objects.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (object === undefined) continue;
      objects.set(oid, object);
      if (object.type === 'tree') {
        for (const entry of treeEntries(repo, oid)) if (entry.mode !== '160000') queue.push(entry.oid);
      }
    }
  };
  const shallow = [];
  const unshallow = [];
  if (depth === null) {
    for (const want of wants) {
      const queue = [want];
      while (queue.length > 0) {
        const current = queue.pop();
        if (objects.has(current)) continue;
        const object = repo.objects.get(current);
        if (object === undefined) continue;
        objects.set(current, object);
        if (object.type === 'commit') {
          const commit = getCommit(repo, current);
          if (commit === null) continue;
          queue.push(commit.tree);
          for (const parent of commit.parents) queue.push(parent);
        } else if (object.type === 'tree') {
          for (const entry of treeEntries(repo, current)) if (entry.mode !== '160000') queue.push(entry.oid);
        } else if (object.type === 'tag') {
          queue.push(peel(repo, current));
        }
      }
    }
  } else {
    const walked = shallowCommits(repo, wants, depth);
    for (const commitOid of walked.commits) {
      const object = repo.objects.get(commitOid);
      if (object === undefined) continue;
      objects.set(commitOid, object);
      const commit = getCommit(repo, commitOid);
      if (commit !== null) addTree(commit.tree);
    }
    for (const want of wants) {
      const object = repo.objects.get(want);
      if (object !== undefined && object.type === 'tag') objects.set(want, object);
    }
    for (const oid of walked.boundary) if (!clientShallow.has(oid)) shallow.push(oid);
    for (const oid of clientShallow) if (walked.commits.has(oid) && !walked.boundary.has(oid)) unshallow.push(oid);
  }
  const send = [];
  for (const [oid, object] of objects) if (!have.has(oid)) send.push({ oid, type: object.type, data: object.data });
  return { objects: send, shallow, unshallow };
}

/** The pack for one fetch, cached: the shallow-clone workload asks fifty times for the same one. */
const packCache = new Map();

/**
 * The plan for one fetch (which objects to send, which shallow boundaries moved), memoized: fifty
 * concurrent shallow clones ask the identical question, and the answer is a pure function of the
 * repository's immutable object graph plus the request's wants, haves and depth.
 */
const planCache = new Map();

function fetchPlan(repo, wants, haves, depth, clientShallow) {
  const key = `${repo.id}|${repo.objects.size}|${depth === null ? 'full' : depth}|${wants.join(',')}|${haves.join(',')}|${[...clientShallow].sort().join(',')}`;
  const cached = planCache.get(key);
  if (cached !== undefined) return cached;
  const plan = fetchObjects(repo, wants, haves, depth, clientShallow);
  if (planCache.size > 500) planCache.clear();
  planCache.set(key, plan);
  return plan;
}

function packFor(repo, objects) {
  const key = `${repo.id}:${objects.length}:${objects.map((object) => object.oid).join(',')}`;
  const cached = packCache.get(key);
  if (cached !== undefined) return cached;
  const pack = writePack(objects);
  if (packCache.size > 200) packCache.clear();
  packCache.set(key, pack);
  return pack;
}

/**
 * The whole v2 fetch response body for one plan: the moved shallow boundaries, then the packfile
 * section. It is a pure function of the plan, so it is built once and handed to every client that
 * asks the same question.
 */
function fetchResponse(repo, plan) {
  if (plan.response !== undefined) return plan.response;
  const parts = [];
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    const lines = [];
    for (const oid of plan.shallow) lines.push(`shallow ${oid}\n`);
    for (const oid of plan.unshallow) lines.push(`unshallow ${oid}\n`);
    parts.push(encodePktLines(['shallow-info\n', ...lines, 'flush']));
  }
  const pack = packFor(repo, plan.objects);
  parts.push(encodePktLines(['packfile\n']));
  parts.push(sidebandStream(1, pack));
  parts.push(pktFlush());
  plan.response = Buffer.concat(parts);
  return plan.response;
}

// ---------------------------------------------------------------- v2 fetch

function wantListOf(args) {
  return args.filter((argument) => argument.startsWith('want ')).map((argument) => argument.slice(5).trim());
}

function haveListOf(args) {
  return args.filter((argument) => argument.startsWith('have ')).map((argument) => argument.slice(5).trim());
}

function shallowListOf(args) {
  return args.filter((argument) => argument.startsWith('shallow ')).map((argument) => argument.slice(8).trim());
}

function depthOf(args) {
  for (const argument of args) {
    if (argument === 'deepen-relative') continue;
    if (argument.startsWith('deepen ')) {
      const value = Number.parseInt(argument.slice(7).trim(), 10);
      if (Number.isFinite(value) && value > 0) return value;
    }
  }
  return null;
}

/** A v2 fetch: acknowledgments while negotiating, else shallow-info (when it moved) and the pack. */
function fetchV2(repo, args, res) {
  const wants = wantListOf(args).filter((oid) => repo.objects.has(oid));
  const haves = haveListOf(args);
  const clientShallow = new Set(shallowListOf(args));
  const depth = depthOf(args);
  const done = args.includes('done');
  const parts = [];
  if (wants.length === 0) {
    parts.push(encodePktLines(['acknowledgments\n', 'NAK\n', 'flush']));
    sendBytes(res, 200, UPLOAD_RESULT, Buffer.concat(parts));
    return;
  }
  if (!done) {
    // The client is still negotiating: name the haves we hold and wait for its next request. A
    // packfile now would be answered with "expected 'acknowledgments'".
    const known = haves.filter((oid) => repo.objects.has(oid));
    const lines = known.length === 0 ? ['NAK\n'] : known.map((oid) => `ACK ${oid}\n`);
    sendBytes(res, 200, UPLOAD_RESULT, encodePktLines(['acknowledgments\n', ...lines, 'flush']));
    return;
  }
  const plan = fetchPlan(repo, wants, haves, depth, clientShallow);
  sendBytes(res, 200, UPLOAD_RESULT, fetchResponse(repo, plan));
}

// ---------------------------------------------------------------- v0 fetch

/** A v0 upload-pack request: want/have/done with side-band-64k, answered with NAK and a pack. */
function fetchV0(repo, body, res) {
  const lines = [];
  try {
    for (const packet of decodePktLines(body)) if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
  } catch {
    sendJson(res, 400, { message: 'unreadable upload-pack request' });
    return;
  }
  const wants = [];
  const haves = [];
  const clientShallow = new Set();
  let depth = null;
  let done = false;
  for (const raw of lines) {
    const line = raw.replace(/\n$/, '');
    if (line.startsWith('want ')) wants.push(line.slice(5).split(' ')[0]);
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) clientShallow.add(line.slice(8).trim());
    else if (line === 'done') done = true;
    else if (line.startsWith('deepen ')) {
      const value = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(value) && value > 0) depth = value;
    }
  }
  if (!done) {
    // v0 negotiation: answer the haves we hold (or NAK) and let the client finish the exchange.
    const known = haves.filter((oid) => repo.objects.has(oid));
    const parts = known.length === 0 ? [pktLine('NAK\n')] : known.map((oid) => pktLine(`ACK ${oid}\n`));
    parts.push(pktFlush());
    sendBytes(res, 200, UPLOAD_RESULT, Buffer.concat(parts));
    return;
  }
  const kept = wants.filter((oid) => repo.objects.has(oid));
  const computed = fetchObjects(repo, kept, haves, depth, clientShallow);
  const parts = [];
  for (const oid of computed.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of computed.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(pktLine('NAK\n'));
  const pack = packFor(repo, computed.objects);
  parts.push(sidebandStream(1, pack));
  parts.push(pktFlush());
  sendBytes(res, 200, UPLOAD_RESULT, Buffer.concat(parts));
}

// ---------------------------------------------------------------- receive-pack

/** Split a receive-pack body into its command list and the packfile that follows it. */
function splitCommands(body) {
  const commands = [];
  let capabilities = [];
  let offset = 0;
  while (offset + 4 <= body.length) {
    const text = body.toString('ascii', offset, offset + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(text)) throw new Error(`invalid pkt-line length ${JSON.stringify(text)}`);
    const length = Number.parseInt(text, 16);
    if (length === 0) {
      offset += 4;
      break;
    }
    if (length < 4 || offset + length > body.length) throw new Error('truncated receive-pack command');
    let line = body.toString('utf8', offset + 4, offset + length);
    offset += length;
    const nul = line.indexOf('\u0000');
    if (nul >= 0) {
      capabilities = line.slice(nul + 1).split(' ').filter(Boolean);
      line = line.slice(0, nul);
    }
    line = line.replace(/\n$/, '');
    const [oldOid, newOid, ref] = line.split(' ');
    if (ref === undefined) throw new Error(`unreadable command line ${JSON.stringify(line)}`);
    commands.push({ oldOid, newOid, ref });
  }
  return { commands, capabilities, packOffset: offset };
}

/** The report-status body a push is answered with, as its own pkt-line stream. */
function reportStream(results, unpackDetail) {
  const lines = [`unpack ${unpackDetail}\n`];
  for (const result of results) {
    lines.push(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`);
  }
  return encodePktLines([...lines, 'flush']);
}

/** Apply one command list to the store, refusing anything that is not a fast-forward. */
function applyCommands(repo, commands) {
  const results = [];
  for (const command of commands) {
    const current = repo.refs.get(command.ref) ?? null;
    const refuse = (reason) => results.push({ ref: command.ref, ok: false, reason });
    if (command.newOid === ZERO_OID) {
      if (current !== null) repo.refs.delete(command.ref);
      results.push({ ref: command.ref, ok: true });
      continue;
    }
    if (!repo.objects.has(command.newOid)) {
      refuse('missing necessary objects');
      continue;
    }
    if (current === null) {
      if (command.oldOid !== ZERO_OID) {
        refuse('non-fast-forward');
        continue;
      }
      repo.refs.set(command.ref, command.newOid);
      results.push({ ref: command.ref, ok: true });
      continue;
    }
    if (command.oldOid !== current) {
      refuse('non-fast-forward');
      continue;
    }
    if (!tagRefName(command.ref) && !isAncestor(repo, current, command.newOid)) {
      refuse('non-fast-forward');
      continue;
    }
    repo.refs.set(command.ref, command.newOid);
    results.push({ ref: command.ref, ok: true });
  }
  return results;
}

/** A receive-pack POST: the command list, the pack, the report, framed per the push capabilities. */
function receivePack(repo, body, res) {
  let parsed;
  try {
    parsed = splitCommands(body);
  } catch (error) {
    sendJson(res, 400, { message: `unreadable receive-pack request: ${error.message}` });
    return;
  }
  const { commands, capabilities, packOffset } = parsed;
  const packBytes = body.subarray(packOffset);
  let unpackDetail = 'ok';
  if (packBytes.length > 0) {
    try {
      const read = readPack(packBytes, (oid) => repo.objects.get(oid) ?? null);
      for (const object of read.objects) putObjectKnown(repo, object.oid, object.type, object.data);
    } catch (error) {
      unpackDetail = `error ${String(error.message).replace(/\s+/g, ' ').slice(0, 200)}`;
    }
  }
  const results = unpackDetail === 'ok' ? applyCommands(repo, commands) : commands.map((command) => ({ ref: command.ref, ok: false, reason: 'unpacker error' }));
  const inner = reportStream(results, unpackDetail);
  if (capabilities.includes('side-band-64k')) {
    sendBytes(res, 200, RECEIVE_RESULT, sidebandStream(1, inner, 65000, true));
    return;
  }
  sendBytes(res, 200, RECEIVE_RESULT, inner);
}

// ---------------------------------------------------------------- the entry point

/**
 * Serve one request under /{owner}/{repo}.git. Answers false when the path is not a git service, so
 * the caller can fall through to its 404. A POST's body is read here, once.
 */
export async function handleGit(forge, req, res, segments, query) {
  if (segments.length < 2) return false;
  const rawName = segments[1];
  if (!rawName.endsWith('.git')) return false;
  const repo = forge.repo(segments[0], rawName.slice(0, -4));
  const rest = segments.slice(2);
  const method = req.method ?? 'GET';
  if (rest[0] === 'info' && rest[1] === 'refs' && method === 'GET') {
    if (repo === null) {
      sendJson(res, 404, { message: 'Not Found' });
      return true;
    }
    const service = query.get('service');
    if (service === 'git-upload-pack') advertise(req, res, repo, service, wantsV2(req));
    else if (service === 'git-receive-pack') advertise(req, res, repo, service, false);
    else sendJson(res, 400, { message: 'info/refs needs a service' });
    return true;
  }
  if (method === 'POST' && (rest[0] === 'git-upload-pack' || rest[0] === 'git-receive-pack')) {
    if (repo === null) {
      sendJson(res, 404, { message: 'Not Found' });
      return true;
    }
    const body = await readBody(req);
    if (body === null) {
      sendJson(res, 413, { message: 'request body too large' });
      return true;
    }
    if (rest[0] === 'git-upload-pack') {
      if (wantsV2(req)) uploadPackV2(repo, body, res);
      else fetchV0(repo, body, res);
    } else {
      receivePack(repo, body, res);
    }
    return true;
  }
  if (repo === null && (rest[0] === 'git-upload-pack' || rest[0] === 'git-receive-pack')) {
    sendJson(res, 404, { message: 'Not Found' });
    return true;
  }
  return false;
}

/** A v2 upload-pack POST: the command line decides between ls-refs and fetch. */
function uploadPackV2(repo, body, res) {
  const outside = [];
  const args = [];
  let command = '';
  let inArgs = false;
  try {
    for (const packet of decodePktLines(body)) {
      if (packet.kind === 'flush') {
        if (command === '') break;
        continue;
      }
      if (packet.kind === 'delim') {
        inArgs = true;
        continue;
      }
      if (packet.kind !== 'data') continue;
      const line = packet.payload.toString('utf8');
      if (!inArgs && line.startsWith('command=')) command = line.slice(8).trim();
      else if (inArgs) args.push(line.replace(/\n$/, ''));
      else outside.push(line);
    }
  } catch (error) {
    sendJson(res, 400, { message: `unreadable upload-pack request: ${error.message}` });
    return;
  }
  if (command === 'ls-refs') {
    sendBytes(res, 200, UPLOAD_RESULT, lsRefsBody(repo, args));
    return;
  }
  if (command === 'fetch') {
    fetchV2(repo, args, res);
    return;
  }
  sendJson(res, 400, { message: `unknown upload-pack command ${JSON.stringify(command)}` });
}

/** Whether a commit tree exists for a revision (used by callers that read a tree from a ref). */
export function treeOfRevision(repo, revision) {
  const oid = resolveRevision(repo, revision);
  return oid === null ? null : commitTree(repo, oid);
}

export { ancestorsOf };
