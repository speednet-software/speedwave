---
name: speedwave-ask
description: Ask which skill or flow fits your situation. A router over the skills in this repo.
disable-model-invocation: true
---

# Ask Matt

You don't remember every skill, so ask.

A **flow** is a path through the skills. Most paths run along one **main flow**, and two **on-ramps** merge onto it. Everything else is standalone, or a vocabulary layer that runs underneath.

## The main flow: idea → ship

The route most work travels. You have an idea and want it built.

1. **`/speedwave-grill-with-docs`** — sharpen the idea by interview. Start here whenever you are **working in a working directory**: it's stateful, retaining what it learns in `SPEEDWAVE.md` and ADRs. (No working directory? Use `/speedwave-grill-me` — see Standalone. Both run the same `/speedwave-grilling` primitive; `grill-with-docs` is the one that leaves a paper trail, which makes it the better of the two whenever a repo is there to leave it in.)
2. **Branch — can you settle every question in conversation?** If a question needs a runnable answer (state, business logic, a UI you have to see), detour through a prototype, bridged by **`/speedwave-handoff`** in both directions (a prototype lives in its own directory, which is exactly what `/speedwave-handoff` is for — see Phase boundaries):
   - **`/speedwave-handoff`** out, then open a fresh session against that file,
   - **`/speedwave-prototype`** to answer the question with throwaway code,
   - **`/speedwave-handoff`** back what you learned, and reference it from the original idea thread.
3. **Branch — is this a multi-session build?**
   - **Yes** → **`/speedwave-to-spec`** (turn the thread into a spec), then **`/speedwave-to-tickets`** to split it into tracer-bullet tickets, each declaring its **blocking edges**. On a local tracker that's one file per ticket under `.speedwave/scratch/<feature>/issues/`, worked blockers-first by hand; on a real tracker the edges become native blocking links, so any ticket whose blockers are done can be grabbed — kick off **`/speedwave-implement`** per ticket, **`/clear`ing context between each one**. Each ticket is self-contained, so the last one's context is disposable.
   - **No** → **`/speedwave-implement`** right here, in the same context window.

   Either way, **`/speedwave-implement`** builds each issue by driving **`/speedwave-tdd`** internally — one red-green slice at a time — then commits and asks you to run **`/speedwave-code-review`**, Speedwave's existing multi-dimensional review orchestrator; it is user-invoked, so you run it and the agent does not. Reach for **`/speedwave-tdd`** on its own when you just want to build a concrete behaviour test-first without a full spec, and **`/speedwave-code-review`** on its own whenever you want to review a branch or PR against a fixed point.

### Context hygiene

Keep steps 1–3 in **one unbroken context window** — don't compact or clear until after `/speedwave-to-tickets` — so the grilling, spec, and tickets all build on the same thinking. Each `/speedwave-implement` then starts fresh, working from the ticket.

The limit on this is the **[smart zone](https://www.aihero.dev/ai-coding-dictionary/smart-zone)**: the window (~150k tokens on state-of-the-art models) within which the model still reasons sharply. If a session approaches it before `/speedwave-to-tickets`, don't push on degraded — `/compact` at the nearest phase boundary and carry on (see Phase boundaries).

## On-ramps

A starting situation that generates work, then merges onto the main flow.

- **Bugs and requests piling up** → **`/speedwave-triage`**. It moves issues through triage roles and produces agent-ready issues, which **`/speedwave-implement`** later picks up.

  Triage is only for issues **you didn't create** — bug reports, incoming feature requests, anything that arrives raw. Tickets that `/speedwave-to-tickets` produced are already agent-ready, so **don't triage them**.

- **Something's broken** → **`/speedwave-diagnosing-bugs`**. For the hard ones: the bug that resists a first glance, the intermittent flake, the regression that crept in between two known-good states. It refuses to theorise until it has a **tight feedback loop** — one command that already goes red on *this* bug — then fixes with a regression test. Its post-mortem hands off to **`/speedwave-improve-codebase-architecture`** when the real finding is that there's no good seam to lock the bug down.

- **A huge, foggy effort — a greenfield project or a huge feature build, too big for one session** → **`/speedwave-wayfinder`**, the most cognitively demanding flow here. When the way from here to the destination isn't visible yet, it charts a **shared map** of **decision tickets** on the issue tracker and resolves them one at a time — producing **decisions, not deliverables** — until the fog is pushed back and the way is clear. Where **`/speedwave-grill-with-docs`** sharpens an idea you can hold in one session, wayfinder is for the idea you can't — and it's slower and denser, so save it for exactly that, never a well-scoped feature.

  When the map clears, **it hands off, it doesn't build**: merge onto the main flow at **`/speedwave-to-spec`**, which collapses the map's linked decisions into a buildable plan, then `/speedwave-to-tickets` and `/speedwave-implement` as usual. Looping the map straight into `/speedwave-implement` skips that collapse and throws the linked detail away — go straight to `/speedwave-implement` only when the effort turned out genuinely small.

## Codebase health

Not feature work — upkeep.

- **`/speedwave-improve-codebase-architecture`** — run whenever you have a spare moment to keep the codebase good for agents to operate in. It surfaces **deepening opportunities**; picking one _generates an idea_ you can take into the main flow at `/speedwave-grill-with-docs`. It's the survey that finds the candidates; **`/speedwave-codebase-design`** (below) is the bench you design the chosen one on.

## Vocabulary underneath

Two model-invoked references that run *beneath* the other skills — each the single source of truth for its vocabulary. Reach for them directly when the **words**, not the process, are the problem; or let the skills above pull them in.

- **`/speedwave-domain-modeling`** — sharpen the project's *domain* language: challenge a fuzzy term, resolve an overloaded word ("account" doing three jobs), record a hard-to-reverse decision as an ADR. It's the active discipline `/speedwave-grill-with-docs` drives to keep `SPEEDWAVE.md` a clean glossary.
- **`/speedwave-codebase-design`** — the deep-module vocabulary (module, interface, depth, seam, adapter, leverage, locality) for designing a module's *shape*: a lot of behaviour behind a small interface at a clean seam. `/speedwave-tdd` and `/speedwave-improve-codebase-architecture` both speak it.

## Phase boundaries

A **phase** is a chunk of work inside a session — the grilling, the implementation, the QA. At the **boundary** between two of them you have five options, and picking between them is the fuzziest decision in this whole map:

- **Continue** — stay put. Costs nothing, loses nothing.
- **`/clear`** — empty the window, when nothing here matters to what's next.
- **`/speedwave-handoff`** — write a portable markdown file. Narrow: only for a **new harness**, a **new directory**, a **colleague**, or forking a side task **mid-phase**. What it buys is portability.
- **Subagent** — send a tightly-scoped task to its own window and get a report back.
- **`/compact`** — compress this context and seed a fresh session with it. The **default**, at the bottom of the tree rather than the first reach.

Read [PHASE-BOUNDARIES.md](PHASE-BOUNDARIES.md) for the ordered tree — the five questions, the reasoning behind each branch, and why the primary-source cost makes **Continue** the one to rule out first. Make the decision **at** a boundary; mid-phase, continue or split the rest into subagents.

## Standalone

Off the main flow entirely.

- **`/speedwave-grill-me`** — the same relentless interview as `/speedwave-grill-with-docs`, but **stateless**: it saves nothing locally and builds no `SPEEDWAVE.md`. Reach for it when you are **not working in a working directory** — sharpening a plan, a design, a piece of writing, anything with no repo under it. If you are in a working directory, use `/speedwave-grill-with-docs` instead: it runs the same interview and leaves a paper trail, so it is strictly the better one.
- **`/speedwave-grilling`** — the interview primitive itself: rounds, the frontier, facts are the agent's job and decisions are yours. `/speedwave-grill-me` and `/speedwave-grill-with-docs` are the two named ways in, and `/speedwave-triage`, `/speedwave-wayfinder` and `/speedwave-improve-codebase-architecture` all run it internally. Reach for it directly only when you want the interview with no wrapper around it.
- **`/speedwave-resolving-merge-conflicts`** — work an in-progress merge or rebase conflict hunk by hunk, resolving by **intent** traced to each side's primary source rather than by picking lines, then finish the operation. It never runs `--abort`. Standalone and off every flow: reach for it when you are already mid-conflict.
- **`/speedwave-prototype`** — a small, throwaway program that answers one design question: does this state model feel right, or what should this UI look like. Throwaway is a constraint on how the code is written, not a promise to destroy it: the answer folds into the real code, and the prototype itself is kept as a **primary source** on a `prototype/<name>` branch out of main, pointed at from the implementation issue. It's the detour in step 2 of the main flow, but reach for it any time a design question is hard to settle on paper.
- **`/speedwave-research`** — delegate reading legwork to a **background agent**: it investigates a question against **primary sources**, then leaves a cited Markdown file in the repo. Keep working while it reads. The file it produces is something to take *into* the main flow at `/speedwave-grill-with-docs` — research feeds the thinking, it doesn't replace it.
- **`/speedwave-to-questionnaire`** — when the thing blocking you isn't in your head or the codebase but in **someone else's**, this writes them a questionnaire to fill in. It's the inverse of `/speedwave-grill-me`: instead of interviewing you about the subject, it interviews you about the **send** — who it's going to, what you need back — and aims the questions at the gap. What comes back is material for `/speedwave-grill-with-docs` or `/speedwave-to-spec`.
- **`/speedwave-wait-what`** — the corrective for a message that didn't land. Use it mid-conversation, inside any other skill, and the agent re-pitches what it just said with the context you were missing, in plain English, using the `SPEEDWAVE.md` vocabulary. It works after the fact; `/speedwave-grill-with-docs` is the upfront cure, because a shared language agreed early is what stops the jargon arriving at all.
- **`/speedwave-teach`** — learn a concept over multiple sessions, using the current directory as a stateful workspace.
- **`/speedwave-writing-for-agents`** — reference for writing documents agents consume: skills, AGENTS.md, pointed-at docs.

## Precondition

**`/speedwave-setup`** — run before your first engineering flow to configure the issue tracker, triage labels, and doc layout the other skills assume. Custom issue trackers also work.
