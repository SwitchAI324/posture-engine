// Tolerant boolean reader for environment variables.
//
// House rule: env booleans are the string "1" for on, "0"/absent for off.
// But readers stay TOLERANT so a stray "TRUE"/"true"/"yes" can never silently
// flip a flag to the wrong state. Any of 1 / true / yes / on (any casing) reads
// as on; anything else (including 0 / false / no / empty / unset) reads as off,
// or the supplied default when unset.
//
// Always returns a real boolean.
export function envBool(name, dflt = false) {
  const v = process.env[name];
  if (v == null || String(v).trim() === "") return dflt;
  return /^(1|true|yes|on)$/i.test(String(v).trim());
}

// True only when the var is explicitly present (any value) — for cases that
// must distinguish "set to something" from "not set at all".
export function envPresent(name) {
  const v = process.env[name];
  return v != null && String(v).trim() !== "";
}
