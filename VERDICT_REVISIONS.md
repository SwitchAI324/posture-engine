# Verdict revisions — blocked → reframe

*Tracked in `compiler/registry_overrides.json` (non-destructive; the
pristine `registry.json` export is untouched). Back-port these to the
master matrix when convenient. Rule applied: a `blocked` cell becomes a
`reframe` when the bit's engine FAILING against the host is itself the
comedy — not a dead end. A block is kept only when the failure isn't
playable or a character truth forbids it.*

---

## Revised (now reframe, ops authored)

**jarl × conrad**  —  was `blocked [structural]`
("Jarl has no boss; Conrad's pressure has no purchase").
Reframed: Conrad's pressure lands on empty air and Jarl annexes it as his
own idea. The pressure failing against an apex peer is the joke. (Adopts
the ops the PoC compiler already carried — this also resolves the
registry-vs-compiler conflict, in the reframe direction.)

**bondi × conrad**  —  was `blocked [structural]`
("No boss above an owner-operator; nowhere to bite").
Reframed: Conrad gravely invokes "upstairs"; Bondi owns the building and
asks who that is. Corporate pressure curdling into bewilderment in front
of a man who answers to no one is funnier than greying him out.

**jarl × bonnie**  —  was `blocked [structural]`
("Jarl won't be policed by HR").
Reframed: HR conduct-policing slides off an apex lord; Bonnie is reduced
to noting things for a record that goes nowhere above him. The policing
failing is the comedy.

---

## Kept blocked (deliberately NOT revised)

These are not reframe candidates and should stay greyed out:

- **völva × tyler**, **rynir × tyler**  —  `[dignity]`. Cryptic knowing
  or interrogation aimed at the terrified intern tips into cruelty.
  Tyler's dignity is a CHARACTER TRUTH (Let It Breathe), not a verdict to
  flip. Leave blocked.
- Other `[structural]` / `[direction]` blocks on bench members not yet
  authored (e.g. skald × bea "[direction]", völva × bea "[structural]")
  are untouched for now — revisit per character when that member's file
  and ops are authored, using the same "is the failure playable?" test.

---

## Mechanism note

Overrides live in `registry_overrides.json` as `"key": "reframe"`. The
compiler applies them OVER the export: `verdictFor(key)` = override ?? the
registry verdict ?? clean. Drop an override and the cell snaps back to its
exported verdict — fully reversible, one line per revision.
