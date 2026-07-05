---
name: speedwave-product-showcase
description: Build a self-contained, dependency-free animated "live product" demo for a landing page — a step carousel that faithfully recreates the real app UI (chat, settings, integrations, logs…) using only HTML + scoped CSS + one inline rAF script. Use when asked to add an animated product walkthrough / hero demo / "show the app in motion" to a marketing site.
---

# Animated product showcase (landing-page "live app" demo)

You are building a **decorative, self-contained animation** that makes a marketing page
feel like a live screen-recording of the real product — without recording anything, without
any animation library, and without a framework runtime. One component: static HTML mocks of
the real UI + scoped CSS + a single inline `<script>` that drives a step carousel via
`requestAnimationFrame`/`setTimeout`, gated by `IntersectionObserver`.

This pattern was distilled from a working hero showcase. Follow it and you avoid the dozen
footguns that this kind of animation hides (memory leaks, concurrent timelines, layout jumps,
reduced-motion violations, mobile breakage). Every rule below earned its place by being a real
bug first.

## Core philosophy

1. **Fidelity over invention.** The demo must mirror the REAL product UI. Before writing a
   pixel, read the actual app's components, theme tokens, copy, icon SVGs, and exact data
   formats (e.g. a token like `[EMAIL:TOKEN_3F9A]`, a model id like `claude-opus-4-8`). Invented
   labels read as fake to anyone who knows the product. Pull real strings; pull the real SVG
   `<path>`s; mirror the real palette variables.
2. **Zero dependencies.** No Framer/GSAP/Lottie, no framework hydration. Just CSS + one inline
   IIFE. It must work as a static HTML island.
3. **Decorative, not interactive.** The whole scene is `aria-hidden="true"`. It illustrates;
   it is not a control surface. Screen readers skip it.
4. **A customer journey, not a slideshow.** Order the steps as the user's real first-run path
   (e.g. setup → create project → settings → integrations → … → the working screen). The
   sequence should tell a story.
5. **Cheap and respectful.** It must pause off-screen, pause on hover, honor
   `prefers-reduced-motion`, and never leak timers. A landing animation that pins a CPU core is
   a bug.

## Architecture: the animation engine

A namespaced scene (`.sw-scene`) contains an app-window chrome (nav rail + topbar + a stage),
a stack of absolutely-positioned **slides** (one per `data-step`), and a row of dots. One IIFE
drives everything. Build the engine with these invariants — they are non-negotiable:

### 1. Generation token (kills concurrent timelines)

The single most important safety mechanism. Quick step switches (autoplay loop + dot click +
hover resume) can otherwise start two `playFrom()` chains that both advance, double-firing
steps and flickering. Guard every async callback with a monotonic token bumped on every reset.

```js
var gen = 0;
function clearAll() {
  gen++; // invalidates all in-flight callbacks
  timers.forEach(clearTimeout);
  timers = [];
  frames.forEach(cancelAnimationFrame);
  frames = [];
}
// after() removes its id once fired, so the array tracks only PENDING timers (no unbounded growth)
function after(ms, fn) {
  var g = gen;
  var t = setTimeout(function () {
    var i = timers.indexOf(t);
    if (i !== -1) timers.splice(i, 1);
    if (running && g === gen) fn(); // stale run → no-op
  }, ms);
  timers.push(t);
  return t;
}
```

Every timer goes through `after()`. Every rAF goes through a `smoothScroll`-style helper that
also checks `running && g === gen` and tracks ONE frame id at a time (swap, don't push-per-frame
— pushing one id per frame across an infinite loop is an unbounded memory leak).

### 2. Single guarded resume path

Pausing/visibility/hover all funnel through ONE function so no entry point can start a
timeline while another is live or while off-screen:

```js
function resume(idx) {
  if (reduce || !visible || hovering) return; // every guard, one place
  stop(); // stop() bumps gen via clearAll()
  running = true;
  playFrom(idx == null ? Math.max(current, 0) : idx);
}
```

- Dot click → `resume(thatIndex)` (and early-return if `hovering`, so it respects the pause).
- `mouseenter` → `hovering = true; stop()`. `mouseleave` → `hovering = false; resume()`.
- IntersectionObserver → on intersect `start()`, else `stop()`. **`mouseleave` must re-check
  `visible`** — otherwise a pointer leaving an already-scrolled-off scene restarts the loop
  off-screen.

### 3. Slide index vs carousel step (decouple them)

If one slide is shown _inside_ another step (e.g. a "create project" modal that appears mid-way
through the "setup" pipeline and then returns), it must NOT be a carousel step with its own dot.
Separate the two concepts: each carousel step carries the `data-step` of the slide it activates.

```js
var STEP_META = [
  { slide: 0, pill: 'first-run setup', rail: '' }, // setup (create-project shown from inside it)
  { slide: 2, pill: 'provider', rail: 'settings' },
  // …                                                 // slide 1 (create-project) has NO dot
];
function showSlide(n) {
  steps.forEach((s) => s.classList.toggle('sw-active', +s.dataset.step === n));
}
function showStep(i) {
  current = i;
  var m = STEP_META[i];
  showSlide(m.slide); /* dots, rail, pill */
}
```

### 4. The loop

```js
function playFrom(idx) {
  if (!running) return;
  showStep(idx);
  SEQUENCE[idx].run(function () {
    // each step's run(done) animates, then calls done
    after(SEQUENCE[idx].hold, function () {
      playFrom((idx + 1) % SEQUENCE.length);
    });
  });
}
```

Each `run(done)` MUST eventually call `done()` on every path (including its guard/early-return),
or the carousel freezes on that step. Reset its own DOM state at the top of `run()` so re-entry
(loop wrap or dot jump) always starts clean.

### 5. A debug hook (build it early, you will need it)

```js
window.__swShowcase = {
  goto: function (i) {
    stop();
    running = true;
    playFrom(i);
  },
  pause: function () {
    stop();
  },
  step: function () {
    return current;
  },
};
```

Indispensable for QA screenshots — drive the carousel deterministically instead of racing
`setTimeout` from the outside.

## Step recipe (per step / `run(done)`)

- **Lists that "scroll" (chat, logs, file trees):** don't use native scroll. Drive `scrollTop`
  via rAF with a gentle sine ease in a sequence of "thumb-flicks" `[distancePx, durationMs,
pauseMs]`. Hide the scrollbar (`scrollbar-width:none` + `::-webkit-scrollbar{display:none}`)
  and mask the edges so rows fade in/out.
- **Toggles / enable flows:** flip the visual toggle FIRST (slide the knob), THEN transition the
  status `configure → starting → running`. Toggling and status flipping simultaneously reads as
  a glitch; the human order is "I clicked, then it reacted".
- **Typing:** reveal text char-by-char with `after(speed, …)`; show a blinking caret only in the
  field currently being typed (move the caret with the focus, don't leave it on an idle field).
- **Button press feedback:** on a simulated click, add a `.press` class (scale ~0.92 + accent
  glow ring) for ~180ms, then remove. Do it for EVERY simulated click (send, create, connect),
  not just one — inconsistency is noticeable.
- **A working-screen step (e.g. chat):** type a prompt → press send → blinking-caret "assistant
  is responding" (NOT three bouncing dots unless the product uses them) → reply. Match the
  product's real message anatomy (e.g. assistant turns may be bubble-less prose, not a card).

## Theme: follow the host site's light/dark

Mirror the real product palette as namespaced `--sw-*` (or project-prefixed) vars. Make ONE mode
the base and override with the site's theme selector (e.g. `html.dark .scene { … }`). Accent
should match the **site's** brand color, not necessarily the product's in-app accent. Add a short
transition on `background-color/border-color/color` so flipping the site theme cross-fades.
Illustrative chips (e.g. a row of accent swatches) use literal hex, not the live accent var.

## Layout in the hero

- Two-column grid on desktop (text | showcase). Give the window breathing room from the
  clipped edge: the hero usually has `overflow:hidden`, so a window flush to the column edge has
  its shadow sliced — leave ~12–24px and center it.
- **Vertical alignment:** align the window's top to the H1 (measure the offset; it's the
  tag-pill height, independent of H1 font-size, so it survives copy changes).
- **Mobile (stacked): do NOT `display:none` the showcase** — that hides your best asset and
  causes layout to "jump". Instead linearise the grid and place the showcase in DOM order where
  it should read (commonly between the subtitle and the "works with"/CTA strip). Split the text
  column into top/bottom blocks with explicit `grid-row` placement so DOM order = mobile order.
  Scale the fixed-px window down with `transform: scale()` + a negative margin to reclaim slack,
  and verify no horizontal overflow.

## Reduced motion

`@media (prefers-reduced-motion: reduce)` is necessary but not sufficient — it can't stop the
JS rAF timelines. So in JS, when reduced motion is set, **park on a representative STATIC slide
and return before any `run()`** (e.g. a settings/integrations slide whose markup is meaningful
without animation — never an empty chat body that only fills via JS). Ensure EVERY entry point
(`start`, dot click, `mouseleave`, debug `play`) honors the `reduce` flag.

## Cleanup

- Disconnect the `IntersectionObserver` and stop timers on `pagehide` (covers bfcache / future
  SPA navigation): `window.addEventListener('pagehide', () => { stop(); io.disconnect(); });`
- Null-guard every `querySelector` a `run()` dereferences; if a hook is missing, call `done()`
  and skip the step rather than throwing inside a timer (a throw freezes the carousel).

## Footgun checklist (verify before shipping)

- [ ] No unbounded `timers[]`/`frames[]` growth (ids removed on fire; one rAF id per scroll anim).
- [ ] Generation token guards every `after()` and rAF callback; rapid dot-spam settles on ONE step.
- [ ] `mouseleave` resume checks `visible` (no off-screen playback).
- [ ] Dot click respects `hovering` (doesn't defeat hover-pause).
- [ ] Every `run(done)` calls `done()` on all paths and resets its own state on entry.
- [ ] Reduced-motion parks on a static, content-rich slide; all entry points honor it.
- [ ] `IntersectionObserver` disconnected on `pagehide`; querySelectors null-guarded.
- [ ] Fixed-height inputs/rows (set `height`, not `min-height`) so empty vs filled don't jump.
- [ ] Edge-fade masks don't clip the FIRST or LAST visible row (header crisp at top; last row
      clears the bottom fade — add bottom padding if needed).
- [ ] Light AND dark verified; site-theme toggle cross-fades; accent = site brand.
- [ ] Mobile: showcase visible (not hidden), correctly ordered, scaled, no horizontal overflow.
- [ ] SVG icons crisp on 1× displays (`shape-rendering: geometricPrecision`), real product paths.

## Verifying

Drive it with `window.__swShowcase.goto(i)` + `pause()` and screenshot each step in BOTH themes
at desktop and mobile widths. Measure, don't eyeball: assert exactly one `.sw-active` slide after
rapid step-spam (no concurrent chains), assert input heights are stable empty-vs-filled, assert
`scrollWidth <= innerWidth` on mobile. A multi-agent review pass (correctness + cleanup angles,
then adversarial verification) catches the leaks/concurrency/reduced-motion gaps that a single
read misses.
