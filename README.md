# make.fun forge

A standalone, GitHub-compatible git forge: one Node process, the standard library only, no git
binary, no network beyond the trial's env. It serves four surfaces from its own in-memory store.

| surface | where | what |
| --- | --- | --- |
| git smart HTTP | `/{owner}/{repo}.git/...` | upload-pack protocol v2 (capabilities, ls-refs, fetch with shallow depth and deepening) and receive-pack v0 (command list, pack, report-status in side-band-64k, fast-forward refusal) |
| REST v3 | `/api/v3/...` | repositories, branches, commits, refs, contents, labels, issues, comments, pull requests, their files and their merge |
| GraphQL v4 | `/api/graphql` | the documents gh and github-mcp-server send: repository, issue and pull-request reads with cursors and ordering, the mutations, `node(id:)`, `__type` introspection, inline fragments, operation batching |
| MCP | `/mcp` | JSON-RPC 2.0 over streamable HTTP: `server/discover` and the `initialize` handshake, `tools/list`, `tools/call` with nine tools |

## The files

- `main.ts` — the entry's life: bind an ephemeral port, `POST $MAKEFUN_ENV_URL/register`, poll
  `GET $MAKEFUN_ENV_URL/done`, exit 0.
- `app.ts` — the listener and the routing between the four surfaces, and the one token check.
- `gitproto.ts` — the git wire: pkt-line codec, object ids, packfile read (ofs/ref deltas, thin
  packs) and write, the delta format, sideband framing.
- `forge.ts` — the store: repositories, refs, objects, ancestry, trees, diffs.
- `githttp.ts` — the smart-HTTP services on top of the store, with the fetch plan and its response
  cached (fifty concurrent shallow clones of one repository share one build).
- `rest.ts` — the REST v3 routes and their views.
- `actions.ts` — the mutating operations every surface shares: issues, comments, pull requests,
  merges.
- `graphql.ts` — a hand-written GraphQL: lexer, parser, executor, schema.
- `mcp.ts` — the MCP transport, the tool table and the tools' effect on the store.
- `http.ts` — JSON replies, body reads, path splitting.

## Running it by hand

```sh
node --experimental-strip-types main.ts        # Node 22 names the flag; Node 23+ strips types itself
```

The forge needs `MAKEFUN_ENV_URL` (the env to register with) and `MAKEFUN_SHOP_TOKEN` (the bearer
token every request must carry; git clients may present it as Basic auth's password instead).

## Layout notes

Everything lives in memory for the life of the process, which is the life of one trial. Ids and
timestamps come from counters, never from a clock or a random source, so two runs of the same
requests build the same objects byte for byte.

## License

MIT — see `LICENSE`.
