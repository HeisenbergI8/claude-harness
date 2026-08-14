---
name: lean-code
description: Discipline for writing the minimum code that solves the problem — search for what already exists before adding anything, and resist premature abstraction. Load BEFORE writing a new file, helper, type, component, or utility, and whenever the task smells like it will produce a lot of code.
---

# Lean Code

The cheapest code to maintain is the code you did not write. This skill runs **before** you type. For
cleaning up code that already exists, use a simplification pass instead — this does not duplicate it.

## The search-first rule

Before writing any new helper, type, hook, or component, **spend one search proving it does not already
exist.** The answer is very often yes.

Check, every time:

- The shared utilities directory named in `CONVENTIONS.md`.
- The canonical reference module — whatever it does, it probably does this too.
- The transport or client layer. **Never hand-roll a fetch wrapper or a URL concatenation** when the
  project has a sanctioned one.
- Any component library the project already ships. Check before building a dialog, table shell, or form
  field from scratch.

If something similar exists but does not quite fit, **prefer extending it over cloning it** — but say so,
since widening a shared helper affects its other callers.

## Questions to pass before adding code

**Does this need to exist?** Not "is it nice" — does removing it break a stated requirement?
Speculative flexibility for a future nobody specified is the most common source of bulk.

**Is this the third time?** Two similar call sites do not justify an abstraction. **Duplication is
cheaper than the wrong abstraction**, and the right shape is usually only visible on the third use.

**Can an existing type carry this?** A new type that is an existing type plus one field is usually a
field, not a type.

**Is this the right layer?** Bulk often comes from code in the wrong place — data shaping done in a view,
fetching done in a helper. Code in the correct layer is usually shorter because the layer already
provides half of it.

## Shapes that bloat any codebase

- **Re-mapping data that a lower layer already normalised.** If you are renaming or re-deriving fields a
  service returned, you are duplicating the mapper.
- **Wrapper components that only pass props through.** If it adds no behaviour, delete it.
- **Defensive coercion at the top layer.** `toNumber(x ?? 0)` in a view means the layer below failed to
  normalise. Fix it there, where it is done once.
- **Hand-rolled loading/error state** when the data layer already exposes it. Do not mirror it into
  local state.
- **Barrel files re-exporting a single symbol.**
- **Comments restating the code.** Comment the *why*, and only where the why is non-obvious. Match the
  surrounding density.
- **An escape-hatch type to silence a type error.** It usually means the domain model is missing a
  field.

## What lean does not mean

Lean is about **quantity of concepts**, not character count. Do not compress at the cost of clarity:

- Keep meaningful names. Do not shorten `participantCount` to `pc`.
- Keep guard clauses and early returns.
- Keep genuine error handling. Removing a real failure path is not simplification.
- Keep the layering. Collapsing a service into its caller makes one file shorter and the codebase worse.
- Keep tests. Boundary tests are the safety net against contract drift.

**A clever one-liner that takes three reads is not lean. Fewer moving parts is lean.**

## Before you say you are done

Reread what you wrote and ask: **what here could be deleted without breaking a stated requirement?**
Delete that. If a file you created is under ~20 lines and has one caller, ask whether it should just
live in the caller.
