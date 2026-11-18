// @ts-nocheck — the runtime strips types; there is no type-checking step in the trial pod.
// The git wire primitives the forge needs and nothing more: pkt-line framing, the object id, the
// packfile in both directions, the delta format git compresses objects with, and the sideband the
// smart-HTTP services frame their payloads in. Everything here works on Buffers and talks to no
// process: there is no git binary in the trial pod, so this file is the git binary.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

/** The all-zero id: what an unborn branch's old or new value is in a receive-pack command. */
export const ZERO_OID = '0000000000000000000000000000000000000000';

/** git's LARGE_PACKET_MAX: the largest pkt-line, its four length bytes included. */
export const PKT_LINE_MAX = 65520;

/** The largest payload one pkt-line carries. */
export const PKT_LINE_MAX_PAYLOAD = PKT_LINE_MAX - 4;

const TYPE_CODE = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

const FLUSH = Buffer.from('0000', 'ascii');
const DELIM = Buffer.from('0001', 'ascii');
const RESPONSE_END = Buffer.from('0002', 'ascii');
const EMPTY = Buffer.alloc(0);
/** The hex digits of a pkt-line length, written without a string allocation. */
const HEX = Buffer.from('0123456789abcdef', 'ascii');

/** Write the four hex digits of `value` at `offset` of `out`. */
function writeLength(out, offset, value) {
  out[offset] = HEX[(value >> 12) & 15];
  out[offset + 1] = HEX[(value >> 8) & 15];
  out[offset + 2] = HEX[(value >> 4) & 15];
  out[offset + 3] = HEX[value & 15];
}

/** A 40-hex object id. */
export function isObjectId(value) {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
}

/** `<type> <size>\0`: the header a git object's SHA-1 is computed over. */
export function objectHeader(type, size) {
  return Buffer.from(`${type} ${size}\u0000`, 'utf8');
}

/** git's object id: SHA-1 over the header and the object's bytes. */
export function hashObject(type, data) {
  const hash = createHash('sha1');
  hash.update(objectHeader(type, data.length));
  hash.update(data);
  return hash.digest('hex');
}

// ---------------------------------------------------------------- pkt-line

/** One data pkt-line: four hex length bytes (payload + 4) then the payload. */
export function pktLine(payload) {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length > PKT_LINE_MAX_PAYLOAD) throw new Error(`pkt-line payload is ${data.length} bytes`);
  const out = Buffer.allocUnsafe(data.length + 4);
  writeLength(out, 0, data.length + 4);
  data.copy(out, 4);
  return out;
}

/** A flush packet. */
export function pktFlush() {
  return FLUSH;
}

/** Frame a list of payloads; the strings 'flush', 'delim' and 'response-end' are control packets. */
export function encodePktLines(items) {
  const parts = [];
  let total = 0;
  for (const item of items) {
    if (item === 'flush' || item === null || item === undefined) {
      parts.push(FLUSH);
      total += 4;
      continue;
    }
    if (item === 'delim') {
      parts.push(DELIM);
      total += 4;
      continue;
    }
    if (item === 'response-end') {
      parts.push(RESPONSE_END);
      total += 4;
      continue;
    }
    const data = typeof item === 'string' ? Buffer.from(item, 'utf8') : item;
    if (data.length > PKT_LINE_MAX_PAYLOAD) throw new Error(`pkt-line payload is ${data.length} bytes`);
    parts.push(data);
    total += data.length + 4;
  }
  const out = Buffer.allocUnsafe(total);
  let offset = 0;
  for (const part of parts) {
    if (part === FLUSH || part === DELIM || part === RESPONSE_END) {
      part.copy(out, offset);
      offset += 4;
      continue;
    }
    writeLength(out, offset, part.length + 4);
    part.copy(out, offset + 4);
    offset += part.length + 4;
  }
  return out;
}

/**
 * Split a complete pkt-line stream into packets. A trailing partial packet is an error: a truncated
 * request is never silently accepted.
 */
export function decodePktLines(buf) {
  const packets = [];
  let offset = 0;
  while (offset + 4 <= buf.length) {
    const text = buf.toString('ascii', offset, offset + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(text)) throw new Error(`invalid pkt-line length ${JSON.stringify(text)}`);
    const length = Number.parseInt(text, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > buf.length) throw new Error('truncated pkt-line');
    packets.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return packets;
}

/** The decoded text of every data packet; control packets dropped. */
export function packetLines(buf) {
  const lines = [];
  for (const packet of decodePktLines(buf)) if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
  return lines;
}

/** One pkt-line carrying a sideband channel byte and its data. */
export function sideband(band, payload) {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  return pktLine(Buffer.concat([Buffer.from([band]), data]));
}

/**
 * Frame `payload` as band packets of at most `limit` payload bytes each, then, when `flush` is
 * set, a flush packet. One allocation for the whole stream, which is what a fetch or a push's
 * report is written from.
 */
export function sidebandStream(band, payload, limit = PKT_LINE_MAX_PAYLOAD - 1, flush = false) {
  const count = Math.ceil(payload.length / limit);
  const size = payload.length + count * 5 + (flush ? 4 : 0);
  if (size === 0) return EMPTY;
  const out = Buffer.allocUnsafe(size);
  let offset = 0;
  let written = 0;
  while (offset < payload.length) {
    const chunk = Math.min(payload.length - offset, limit);
    writeLength(out, written, chunk + 5);
    out[written + 4] = band;
    payload.copy(out, written + 5, offset, offset + chunk);
    written += chunk + 5;
    offset += chunk;
  }
  if (flush) FLUSH.copy(out, written);
  return out;
}

// ---------------------------------------------------------------- object bodies

/** Parse a tree object into its entries, in stored order. */
export function parseTree(data) {
  const entries = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('tree entry is truncated');
    entries.push({
      mode: data.toString('ascii', offset, space),
      name: data.toString('utf8', space + 1, nul),
      oid: data.toString('hex', nul + 1, nul + 21),
    });
    offset = nul + 21;
  }
  return entries;
}

/** git's tree order: byte order of the name, a directory compared as if it ended in '/'. */
export function compareTreeNames(a, b) {
  const left = a.mode === '40000' ? `${a.name}/` : a.name;
  const right = b.mode === '40000' ? `${b.name}/` : b.name;
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

/** Build a tree object's bytes from entries, sorted the way git sorts them. */
export function buildTree(entries) {
  const parts = [];
  for (const entry of [...entries].sort(compareTreeNames)) {
    if (!isObjectId(entry.oid)) throw new Error(`tree entry ${entry.name} has a bad id`);
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\u0000`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Parse a commit's headers and message. */
export function parseCommit(data) {
  const text = data.toString('utf8');
  const blank = data.indexOf('\n\n');
  const headerText = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2);
  let tree = '';
  let author = '';
  let committer = '';
  const parents = [];
  for (const line of headerText.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5);
    else if (line.startsWith('parent ')) parents.push(line.slice(7));
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

/** Parse an annotated tag's headers and message. */
export function parseTag(data) {
  const text = data.toString('utf8');
  const blank = data.indexOf('\n\n');
  const headerText = blank < 0 ? text : text.slice(0, blank);
  const headers = new Map();
  for (const line of headerText.split('\n')) {
    const space = line.indexOf(' ');
    if (space > 0) headers.set(line.slice(0, space), line.slice(space + 1));
  }
  return {
    object: headers.get('object') ?? '',
    type: headers.get('type') ?? '',
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : text.slice(blank + 2),
  };
}

/** Build a commit's bytes. The identity and time are the caller's, never a clock read here. */
export function buildCommit({ tree, parents, message, author, committer, timestamp, timezone }) {
  const zone = timezone ?? '+0000';
  const who = `${author} ${timestamp} ${zone}`;
  const other = `${committer ?? author} ${timestamp} ${zone}`;
  const lines = [`tree ${tree}`];
  for (const parent of parents ?? []) lines.push(`parent ${parent}`);
  lines.push(`author ${who}`, `committer ${other}`, '');
  return Buffer.from(`${lines.join('\n')}\n${message}`, 'utf8');
}

// ---------------------------------------------------------------- the delta format

/** Apply one git delta (copy/insert instructions) to a base object's bytes. */
export function applyDelta(base, delta) {
  let offset = 0;
  const readVarint = () => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta varint is truncated');
      const byte = delta[offset++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) return value;
      if (shift > 63) throw new Error('delta varint is too long');
    }
  };
  const sourceSize = readVarint();
  const targetSize = readVarint();
  if (sourceSize !== base.length) throw new Error(`delta expects a ${sourceSize}-byte base, got ${base.length}`);
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy offset is truncated');
          copyOffset += delta[offset++] * 2 ** shift;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy size is truncated');
          copySize += delta[offset++] * 2 ** shift;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy is out of the base');
      if (written + copySize > targetSize) throw new Error('delta writes past its target');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (offset + literal > delta.length) throw new Error('delta insert is truncated');
      if (written + literal > targetSize) throw new Error('delta writes past its target');
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

// ---------------------------------------------------------------- packfile read

function readEntrySize(buffer, start) {
  if (start >= buffer.length) throw new Error('pack entry has no header');
  let byte = buffer[start];
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('pack entry size is truncated');
    byte = buffer[offset++];
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (shift > 63) throw new Error('pack entry size varint is too long');
  }
  return { size, next: offset, first };
}

function readOfsDeltaBase(buffer, start) {
  if (start >= buffer.length) throw new Error('ofs-delta has no base offset');
  let byte = buffer[start];
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('ofs-delta base offset is truncated');
    byte = buffer[offset++];
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { value, next: offset };
}

/** Inflate one zlib stream at `offset` of `buffer`, reporting how many bytes it consumed. */
function inflateAt(buffer, offset) {
  const result = inflateSync(buffer.subarray(offset), { info: true });
  const consumed = result.engine.bytesWritten;
  if (!consumed || consumed <= 0) throw new Error(`zlib stream at ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + consumed };
}

/**
 * Read a packfile and resolve every object in it, including OFS_DELTA and REF_DELTA. `resolveBase`
 * answers a base object a thin pack leaves out (the client already holds it) as {type, data}.
 * Answers {objects: [{oid, type, data}], declaredCount, deltaCount, version}. Throws on any
 * corruption: a pack that does not recompute to its trailer is never accepted.
 */
export function readPack(buffer, resolveBase) {
  if (buffer.length < 32) throw new Error(`pack is ${buffer.length} bytes, too short`);
  if (buffer.toString('ascii', 0, 4) !== 'PACK') throw new Error('pack does not start with PACK');
  const version = buffer.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = buffer.readUInt32BE(8);
  const trailerStart = buffer.length - 20;
  const trailer = buffer.toString('hex', trailerStart);
  const computed = createHash('sha1').update(buffer.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computed) throw new Error(`pack trailer ${trailer} does not match its bytes ${computed}`);

  const raw = [];
  const byOffset = new Map();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readEntrySize(buffer, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry = { offset: entryOffset, typeCode, size: header.size, data: null, baseOffset: -1, baseOid: null, base: null, resolved: null, resolvedType: null, oid: null };
    if (typeCode === 6) {
      const base = readOfsDeltaBase(buffer, offset);
      offset = base.next;
      entry.baseOffset = entryOffset - base.value;
      if (entry.baseOffset < 12 || entry.baseOffset >= entryOffset) throw new Error(`ofs-delta at ${entryOffset} names an invalid base`);
    } else if (typeCode === 7) {
      if (offset + 20 > trailerStart) throw new Error('ref-delta base id is truncated');
      entry.baseOid = buffer.toString('hex', offset, offset + 20);
      offset += 20;
    } else if (CODE_TYPE[typeCode] === undefined) {
      throw new Error(`pack entry ${index} has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(buffer.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) throw new Error(`pack entry at ${entryOffset} declares ${header.size} bytes but inflated to ${inflated.data.length}`);
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error(`pack has ${trailerStart - offset} stray bytes before its trailer`);

  const byOid = new Map();
  const resolve = (entry) => {
    if (entry.resolved !== null) return entry;
    if (entry.resolving) throw new Error(`delta cycle at pack offset ${entry.offset}`);
    entry.resolving = true;
    if (entry.typeCode === 6) {
      const base = byOffset.get(entry.baseOffset);
      if (!base) throw new Error(`ofs-delta base at ${entry.baseOffset} is not in the pack`);
      resolve(base);
      entry.resolvedType = base.resolvedType;
      entry.resolved = applyDelta(base.resolved, entry.data);
    } else if (entry.typeCode === 7) {
      const inPack = byOid.get(entry.baseOid);
      if (inPack) {
        resolve(inPack);
        entry.resolvedType = inPack.resolvedType;
        entry.resolved = applyDelta(inPack.resolved, entry.data);
      } else {
        const external = resolveBase === undefined ? undefined : resolveBase(entry.baseOid);
        if (!external) throw new Error(`ref-delta base ${entry.baseOid} is neither in the pack nor in the repository`);
        entry.resolvedType = external.type;
        entry.resolved = applyDelta(external.data, entry.data);
      }
    } else {
      entry.resolvedType = CODE_TYPE[entry.typeCode];
      entry.resolved = entry.data;
    }
    entry.resolving = false;
    entry.oid = hashObject(entry.resolvedType, entry.resolved);
    byOid.set(entry.oid, entry);
    return entry;
  };

  const objects = [];
  let deltaCount = 0;
  for (const entry of raw) {
    resolve(entry);
    if (entry.typeCode === 6 || entry.typeCode === 7) deltaCount += 1;
    objects.push({ oid: entry.oid, type: entry.resolvedType, data: entry.resolved });
  }
  return { objects, declaredCount, deltaCount, version };
}

// ---------------------------------------------------------------- packfile write

function packObjectHeader(type, size) {
  const code = TYPE_CODE[type];
  if (code === undefined) throw new Error(`no pack type code for ${type}`);
  const bytes = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/**
 * Build a packfile from complete objects (no deltas: correctness first, and the objects a forge
 * sends are already small). `objects` is [{type, data}] in the caller's order.
 */
export function writePack(objects) {
  const parts = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(packObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

/** SHA-1 of every pack byte before its 20-byte trailer. */
export function packChecksum(pack) {
  if (pack.length < 20) throw new Error('pack is shorter than its trailer');
  return createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest('hex');
}
