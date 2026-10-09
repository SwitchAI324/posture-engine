// api/version.js
// BUILD: version-report v6 2026-10-08
// ----------------------------------------------------------------------
// GET /api/version            -> plain-text report (copy/paste into any chat)
// GET /api/version?json=1     -> same data as JSON
//
// "What is actually deployed right now?" For each key file it reads the
// DEPLOYED copy, prints a short content hash (same hash = same file), and
// checks for marker strings that only exist in the current version. It also
// reports the Vercel deployment/commit, the behavior flags (IVR_OPEN etc.),
// whether the secrets are SET (never their values), and the registry state
// for the IVR / mailbox bits. Read-only, no secrets, safe to open in a browser.
//
// MAINTENANCE: when a new piece ships, add its marker to EXPECT below.
// A file Vercel did not bundle shows "not readable here" (not a failure).
// ----------------------------------------------------------------------
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// Each reader uses a literal path so Vercel's file tracer bundles the file.
const READERS = {
  "chat/completions.js": () => fs.readFileSync(path.join(__dirname, "chat/completions.js"), "utf8"),
  "_bits_scorer.js": () => fs.readFileSync(path.join(__dirname, "_bits_scorer.js"), "utf8"),
  "_bits_registry.js": () => fs.readFileSync(path.join(__dirname, "_bits_registry.js"), "utf8"),
  "compiler/_bits_directives.js": () => fs.readFileSync(path.join(__dirname, "compiler/_bits_directives.js"), "utf8"),
  "compiler/host_prompt_source.json": () => fs.readFileSync(path.join(__dirname, "compiler/host_prompt_source.json"), "utf8"),
  "_identity_pivot.js": () => fs.readFileSync(path.join(__dirname, "_identity_pivot.js"), "utf8"),
  "compiler/_identity_pivots.js": () => fs.readFileSync(path.join(__dirname, "compiler/_identity_pivots.js"), "utf8"),
  "hydrate.js": () => fs.readFileSync(path.join(__dirname, "hydrate.js"), "utf8"),
  "_store.js": () => fs.readFileSync(path.join(__dirname, "_store.js"), "utf8"),
  "livekit-webhook.js": () => fs.readFileSync(path.join(__dirname, "livekit-webhook.js"), "utf8"),
  "recordings.js": () => fs.readFileSync(path.join(__dirname, "recordings.js"), "utf8"),
  "recordings-token.js": () => fs.readFileSync(path.join(__dirname, "recordings-token.js"), "utf8"),
  "recording-link.js": () => fs.readFileSync(path.join(__dirname, "recording-link.js"), "utf8"),
  "cron/purge-recordings.js": () => fs.readFileSync(path.join(__dirname, "cron/purge-recordings.js"), "utf8"),
  // files owned by other chats: hash + BUILD label shown, no expected markers yet
  "phone/recap.js": () => fs.readFileSync(path.join(__dirname, "phone/recap.js"), "utf8"),
  "phone/dispatch-callbacks.js": () => fs.readFileSync(path.join(__dirname, "phone/dispatch-callbacks.js"), "utf8"),
  "phone/dial.js": () => fs.readFileSync(path.join(__dirname, "phone/dial.js"), "utf8"),
  "phone/intake.js": () => fs.readFileSync(path.join(__dirname, "phone/intake.js"), "utf8"),
  "phone/inbound-check.js": () => fs.readFileSync(path.join(__dirname, "phone/inbound-check.js"), "utf8"),
  "phone/inbound-complete.js": () => fs.readFileSync(path.join(__dirname, "phone/inbound-complete.js"), "utf8"),
  "phone/prompt-compile.js": () => fs.readFileSync(path.join(__dirname, "phone/prompt-compile.js"), "utf8"),
  "phone/sms-inbound.js": () => fs.readFileSync(path.join(__dirname, "phone/sms-inbound.js"), "utf8"),
  "phone/sms-send.js": () => fs.readFileSync(path.join(__dirname, "phone/sms-send.js"), "utf8"),
  "phone/sms-optin.js": () => fs.readFileSync(path.join(__dirname, "phone/sms-optin.js"), "utf8"),
  "phone/call-live.js": () => fs.readFileSync(path.join(__dirname, "phone/call-live.js"), "utf8"),
  "_emails.js": () => fs.readFileSync(path.join(__dirname, "_emails.js"), "utf8"),
  "book.js": () => fs.readFileSync(path.join(__dirname, "book.js"), "utf8"),
  "claim.js": () => fs.readFileSync(path.join(__dirname, "claim.js"), "utf8"),
  "share-link.js": () => fs.readFileSync(path.join(__dirname, "share-link.js"), "utf8"),
  "join.js": () => fs.readFileSync(path.join(__dirname, "join.js"), "utf8"),
  "calls.js": () => fs.readFileSync(path.join(__dirname, "calls.js"), "utf8"),
  "control.js": () => fs.readFileSync(path.join(__dirname, "control.js"), "utf8"),
  "render.js": () => fs.readFileSync(path.join(__dirname, "render.js"), "utf8"),
  "browse.js": () => fs.readFileSync(path.join(__dirname, "browse.js"), "utf8"),
  "trapline.js": () => fs.readFileSync(path.join(__dirname, "trapline.js"), "utf8"),
  "_pools.js": () => fs.readFileSync(path.join(__dirname, "_pools.js"), "utf8"),
  "meeting.js": () => fs.readFileSync(path.join(__dirname, "meeting.js"), "utf8"),
  "phone/mint-token.js": () => fs.readFileSync(path.join(__dirname, "phone/mint-token.js"), "utf8"),
  "phone/status.js": () => fs.readFileSync(path.join(__dirname, "phone/status.js"), "utf8"),
  // root-level HTML pages (one folder up from api/)
  "book.html": () => fs.readFileSync(path.join(__dirname, "..", "book.html"), "utf8"),
  "claim.html": () => fs.readFileSync(path.join(__dirname, "..", "claim.html"), "utf8"),
  "join.html": () => fs.readFileSync(path.join(__dirname, "..", "join.html"), "utf8"),
  "reschedule.html": () => fs.readFileSync(path.join(__dirname, "..", "reschedule.html"), "utf8"),
  "phone-status.html": () => fs.readFileSync(path.join(__dirname, "..", "phone-status.html"), "utf8"),
  "sms-optin.html": () => fs.readFileSync(path.join(__dirname, "..", "sms-optin.html"), "utf8"),
  "terms.html": () => fs.readFileSync(path.join(__dirname, "..", "terms.html"), "utf8"),
  "privacy.html": () => fs.readFileSync(path.join(__dirname, "..", "privacy.html"), "utf8"),
  "mead_hall_live.html": () => fs.readFileSync(path.join(__dirname, "..", "mead_hall_live.html"), "utf8"),
  "sim_director.html": () => fs.readFileSync(path.join(__dirname, "..", "sim_director.html"), "utf8"),
};

// marker strings that must appear in the CURRENT version of each file.
// [label, substring]
const EXPECT = {
  "chat/completions.js": [
    ["BIT-350 mailbox gag", "MAILBOX-GAG FIRING"],
    ["voicemail mode fix", "VOICEMAIL-MODE bit suppressed"],
    ["prefix/tail cache split", "_prefixText"],
    ["identity pivot wired", "IDENTITY-PIVOT callId"],
  ],
  "_identity_pivot.js": [["pivot module", "planIdentityPivot"], ["story save", "set_call_identity_story"]],
  "compiler/_identity_pivots.js": [["Canon line library", "stand_in"], ["stand-in lines are standing facts", "never at his desk"]],
  "_bits_scorer.js": [["BIT-350 trigger", "prior_mailbox_unavailable"]],
  "compiler/_bits_directives.js": [["BIT-350 directive", "BIT-350"]],
  "compiler/host_prompt_source.json": [["v0.29 IVR pickup exception", "EXCEPTION, IVR PICKUP ONLY"], ["v0.30 stand-in is a standing arrangement", "STANDING ARRANGEMENT"], ["v0.31 identity lines paragraph", "IDENTITY LINES HANDED TO YOU"]],
  "hydrate.js": [
    ["phone token fallback", "TOKEN-FALLBACK-FROM-JOB"],
    ["call-state reset", "CALL-STATE-RESET"],
  ],
  "_store.js": [
    ["recording key normalizer", "normalizeRecordingKey"],
    ["call row reset", "resetCallRow"],
  ],
  "livekit-webhook.js": [
    ["ready signal to recap", 'recording_status: "ready"'],
    ["web owner resolver", "resolve_recording_owner OK"],
    ["owner never blanked", "userId: userId || undefined"],
  ],
  "recordings.js": [["slug-scoped tokens", "claims.slug"]],
  "recordings-token.js": [["slug in token mint", "SLUG_RE"]],
  "recording-link.js": [["shared key helper", "_recording_key"]],
  "cron/purge-recordings.js": [["purge key derivation", "source="]],
};

const FLAGS = [
  "IVR_OPEN", "TRIGGER_MATCH", "TEXTURE_ROTATION", "MOVES_OWED_REINJECT_ALL",
  "GAG_OPEN_RATE", "IDENTITY_PIVOT", "MIN_GAP", "INJECT_BAR", "MAX_TOKENS", "ANTHROPIC_MODEL",
];
const SECRETS = [
  "RECORDING_TOKEN_SECRET", "PHONE_INTAKE_SECRET", "CRON_SECRET",
  "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "ANTHROPIC_API_KEY",
  "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET",
];

// A file may carry a line like  // BUILD: recap v14 2026-10-07  near the top.
// Shown next to its hash so a human can compare it with what a chat said it shipped.
function buildLabel(text) {
  const m = /BUILD:\s*([^\n\r]{1,80})/.exec(String(text).slice(0, 4000));
  return m ? m[1].trim().replace(/(\*\/|-->)\s*$/, "").trim() : null;
}

function hashOf(text) {
  return crypto.createHash("sha1").update(text).digest("hex").slice(0, 8);
}

async function build() {
  const files = {};
  for (const name of Object.keys(READERS)) {
    let text = null;
    try { text = READERS[name](); } catch { /* not bundled */ }
    if (text == null) {
      files[name] = { readable: false };
      continue;
    }
    const checks = (EXPECT[name] || []).map(([label, needle]) => ({ label, ok: text.includes(needle) }));
    files[name] = { readable: true, hash: hashOf(text), bytes: text.length, build: buildLabel(text), checks };
  }

  const registry = {};
  try {
    const mod = await import("./_bits_registry.js");
    const BITS = mod.BITS || [];
    registry.count = BITS.length;
    for (const id of ["BIT-347", "BIT-349", "BIT-350"]) {
      const b = BITS.find((x) => x && x.id === id);
      registry[id] = b ? (b.status || "active") : "absent";
    }
  } catch (e) {
    registry.error = String((e && e.message) || e).slice(0, 120);
  }

  const flags = {};
  for (const f of FLAGS) flags[f] = process.env[f] === undefined ? "(unset)" : process.env[f];
  const secrets = {};
  for (const s of SECRETS) secrets[s] = !!process.env[s];

  const e = process.env;
  return {
    generated_at: new Date().toISOString(),
    deployment: {
      id: e.VERCEL_DEPLOYMENT_ID || null,
      commit: (e.VERCEL_GIT_COMMIT_SHA || "").slice(0, 7) || null,
      commit_message: e.VERCEL_GIT_COMMIT_MESSAGE || null,
      env: e.VERCEL_ENV || null,
    },
    files, registry, flags, secrets_set: secrets,
  };
}

function toText(d) {
  const L = [];
  L.push("PE VERSION REPORT  " + d.generated_at);
  L.push("deployment " + (d.deployment.id || "?") + "  commit " + (d.deployment.commit || "?") + "  env " + (d.deployment.env || "?"));
  if (d.deployment.commit_message) L.push("commit message: " + d.deployment.commit_message);
  L.push("");
  let missing = 0, unreadable = 0;
  L.push("FILES  (ok = expected pieces found, -- = no checks yet, [..] = the file's own BUILD label)");
  for (const [name, f] of Object.entries(d.files)) {
    if (!f.readable) { unreadable++; L.push("  ?  " + name + "  not readable here"); continue; }
    const bad = f.checks.filter((c) => !c.ok);
    missing += bad.length;
    L.push("  " + (bad.length ? "XX" : (f.checks.length ? "ok" : "--")) + "  " + name + "  #" + f.hash + (f.build ? "  [" + f.build + "]" : "") + (bad.length ? "  MISSING: " + bad.map((c) => c.label).join("; ") : ""));
  }
  L.push("");
  L.push("REGISTRY: " + (d.registry.error ? "error " + d.registry.error
    : d.registry.count + " bits; BIT-347 " + d.registry["BIT-347"] + ", BIT-349 " + d.registry["BIT-349"] + ", BIT-350 " + d.registry["BIT-350"]));
  L.push("FLAGS: " + Object.entries(d.flags).map(([k, v]) => k + "=" + v).join("  "));
  L.push("SECRETS SET: " + Object.entries(d.secrets_set).map(([k, v]) => k + "=" + (v ? "yes" : "NO")).join("  "));
  L.push("");
  L.push(missing === 0
    ? "VERDICT: every expected piece is present" + (unreadable ? " (" + unreadable + " file(s) could not be read here, so those are unchecked)" : "")
    : "VERDICT: " + missing + " expected piece(s) MISSING - an older file is deployed");
  return L.join("\n");
}

module.exports = async function handler(req, res) {
  try {
    const d = await build();
    res.setHeader("Cache-Control", "no-store");
    const wantJson = /[?&]json=1\b/.test(req.url || "");
    if (wantJson) {
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify(d, null, 2));
    }
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    return res.end(toText(d));
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "text/plain");
    return res.end("version report failed: " + String((e && e.message) || e).slice(0, 200));
  }
};
