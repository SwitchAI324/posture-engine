# Posture Engine — wiring the assembler into the call path

*The merge (assemble.js) is now connected to the proxy. This is how the
pieces talk and what you set up to run it live.*

---

## The shape

Assembly happens ONCE at pre-snap and is frozen; the proxy just reads it
per turn. Two endpoints, one store:

```
  MEAD HALL (Director locks the call)
        |
        v   POST /api/presnap   { call_id, posture, armedBench, bits, ... }
  ┌─────────────────┐
  │  /api/presnap   │  NODE runtime — runs the compiler/assembler,
  │  (assemble +    │  freezes ONE prefix, writes it to the store
  │   store.set)    │
  └────────┬────────┘
           v
     ┌───────────┐        call_prefix row:
     │  STORE    │  <───  { call_id, prefix, posture_line, updated_at }
     │ (Supabase)│
     └─────┬─────┘
           ^   getCall(call_id)  — one indexed read, per turn
  ┌────────┴─────────┐
  │ /chat/completions│  EDGE runtime — reads the frozen prefix + posture
  │  (read + stream) │  line, sends cached block to Claude, streams back
  └──────────────────┘
        ^
        |   Vapi POSTs the conversation every turn
  VAPI (live call)
```

Why two runtimes: the compiler is CommonJS with require()'d JSON — fine on
Node, impossible on Edge. So pre-snap is Node, the per-turn proxy is Edge,
and they share only the store. The proxy never imports the compiler.

---

## Setup (one time)

### 1. Create the store table

In Supabase (project `lxmzwftmshqghkyapibg`) → SQL editor:

```sql
create table if not exists call_prefix (
  call_id      text primary key,
  prefix       text,
  posture_line text,
  gear         text default 'alive',
  updated_at   timestamptz default now()
);
```

The `gear` column holds the current doubt-gear (alive / slipping /
foregone). Pre-snap seeds it to `alive`; the proxy's FORCE-SET layer
flips it per turn from the caller's words and persists the new value off
the hot path. The nuanced drift read (the Governor) is Phase 4.

### 2. Environment variables (Vercel → Settings → Environment Variables)

```
ANTHROPIC_API_KEY            (proxy → Claude)
SUPABASE_URL                 e.g. https://lxmzwftmshqghkyapibg.supabase.co
SUPABASE_SERVICE_ROLE_KEY    server-side key; bypasses RLS
ANTHROPIC_MODEL              (optional) default claude-haiku-4-5-20251001
```

The service-role key is used only server-side (both functions), so it
never reaches a browser. Redeploy after adding env vars.

---

## How a call flows

1. Director locks the call in the Mead Hall. The Mead Hall POSTs to
   `/api/presnap`:
   ```json
   { "call_id": "<the Vapi call id>", "posture": "skald",
     "armedBench": ["conrad", "bonnie"], "bits": ["echo", "wrong_window"],
     "target": "Marcus @ vendor", "tactic": "b2b_saas" }
   ```
   Pre-snap assembles the frozen prefix (host base + bits + reframed bench
   + context), seeds the posture line to ALIVE, and stores the row. It
   returns `{ ok, bench_armed, excluded, prefix_tokens, prefix_hash }` —
   `excluded` tells you which armed members were dropped (blocked / not
   built) so the Mead Hall can grey them.

2. The call connects. Vapi POSTs `/chat/completions` every turn. The proxy
   reads the `call_prefix` row for that `call_id`, sends the prefix as the
   cached block + the posture line as the mutable block, and streams the
   Host line. Cache logs (`cache {...}`) show `cache_read` climbing after
   turn one.

3. The posture engine (Phase 3, next) updates ONLY `posture_line` on the
   same row as the call moves through doubt-gears. The prefix never
   changes mid-call.

---

## Fallback (so nothing breaks before the Mead Hall is wired)

If there's no `call_prefix` row for a call (pre-snap wasn't called, or the
store isn't configured), the proxy falls back to Vapi's raw system prompt
— exactly the Phase 1 behavior. You can deploy this now and calls keep
working; pre-snap assembled prefixes take over for any call that has one.

---

## Lag note

The per-turn proxy does exactly ONE external read (the `call_prefix` row,
an indexed PK lookup) before streaming. That is the single sanctioned
hot-path read (BUILD §6.3) — a row read, never an LLM round-trip. The
posture engine's writes and the assembly all happen off the speech path.
Invariant intact.

---

## Test

- Local, no Supabase: `node wire_test.js` — runs pre-snap → store → proxy
  build against a mock store and asserts the cached block stays identical
  across a posture change.
- Live: set the env vars, deploy, `POST /api/presnap` with a test
  `call_id`, then `GET` that row in Supabase to confirm the prefix landed.
  Place a call and watch the proxy's cache logs.
