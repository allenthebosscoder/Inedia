# Design: Fill support for Workday's non-ARIA "moniker search box" widget (Bug 7)

## Problem

Some Workday fields — confirmed for Phone Country Code, likely others — use a widget
that looks superficially like the ARIA combobox pattern (Bug 2/2b, already shipped)
but exposes none of the ARIA markers that pattern relies on. The trigger `<input>`
has no `aria-haspopup`, `role`, or `aria-controls` anywhere in its ancestor chain up
to `<html>`; its only distinguishing marker is `data-uxi-widget-type="selectinput"`,
which it shares with the already-handled ARIA-pattern School field. Its results popup
uses `data-automation-id="promptOption"` instead of `role="option"`, and — confirmed
by tracing its real ancestor chain on a live Workday page — renders as a portal with
no containment relationship to the trigger at all.

Because neither the ARIA combobox detection query (`[aria-haspopup="listbox"]`) nor
the `role="option"` result-finding query can ever match this widget, it currently
falls through to plain-text field handling: `setNativeValue` types the value into the
box, but no option is ever selected, and no flag appears since the fill engine
believes it successfully filled a text field. See `docs/QA-FINDINGS.md` Bug 7 for the
full evidence trail (captured DOM, ancestor-chain traces, and the ruled-out mousedown
hypothesis).

## Goal

Detect this widget family distinctly from plain text inputs (and distinctly from the
already-handled ARIA School widget, despite sharing `data-uxi-widget-type`), and
extend the existing combobox fill pipeline to actually select a matching option
instead of leaving typed free-text behind.

## Non-goals

- Handling genuinely unknown/future Workday widget variants beyond what's been
  observed and evidenced here — those should surface as a flagged field (safe
  failure) and get their own QA finding if seen.
- Confirming `closePopup()`'s Escape-key behavior specifically for this widget —
  carried over unconfirmed, same as it already is for other widget variants.

## Detection

`generic-adapter.ts`'s `extractFields` currently runs two queries: a native
`input, select, textarea` query (skipping anything with
`aria-haspopup="listbox"`) and an ARIA-combobox query (`[aria-haspopup="listbox"]`).

Add a third query:

```js
input[data-uxi-widget-type="selectinput"]:not([aria-haspopup="listbox"])
```

Matches are pushed with `kind: 'combobox'` — the same kind used by the ARIA path.
No new `FieldKind` is needed: the distinguishing signal (presence or absence of
`aria-haspopup`) is always readable directly off the trigger element at fill time,
so there's no information to preserve between detection and fill.

The native-input query's existing skip condition must also skip these elements
(currently only skips `aria-haspopup === 'listbox'`), so they don't get
double-classified as plain text fields.

**Working assumption, not fully verified beyond the two known cases (School,
Phone Country Code):** `data-uxi-widget-type="selectinput"` is Workday's generic
"select input" component, configured two ways — an ARIA-driven variant (School) and
a portal-driven variant (Phone Country Code). Splitting on `aria-haspopup` presence
is the best evidence-based rule available; worth revisiting if a third variant shows
up that doesn't fit either bucket.

## Fill-time behavior

`combobox-fill.ts`'s per-field loop decides the widget variant once, from the
trigger's own attributes:

```js
const isMonikerWidget = trigger.hasAttribute('data-uxi-widget-type') && !trigger.hasAttribute('aria-haspopup');
```

This selects which strategy `waitForOptions` uses to find rendered options:

- **ARIA path (existing, unchanged):** `trigger.getAttribute('aria-controls')` →
  `container.querySelectorAll('[role="option"]')`.
- **Moniker path (new):** `document.querySelectorAll('[data-automation-id="promptOption"]')`,
  queried globally rather than scoped to any container, since the popup is a portal
  with no containment or ID relationship to the trigger.

Everything downstream of "find the option elements" is unchanged and fully reused:
`buildCandidates`/`findMatchIndex` against each option's `.textContent` (observed
identical to `data-automation-label` in the captured markup, so no need to prefer
one over the other), `clickWithoutDefault` (mousedown+mouseup+click) on the match,
flag-on-no-match, and flag-and-clear-typed-value when no options are ever found.

The trigger-click-first step (`if (aria-expanded !== 'true') clickWithoutDefault(trigger)`)
and the type-then-Enter fallback are also reused verbatim. For this widget family the
first `waitForOptions` call is expected to always return empty — confirmed live:
suggestions only render after Enter is pressed, never just from typing — so every
moniker-widget fill will realistically go through the fallback path, same as School
does today.

## Known limitations (carried over, not newly introduced)

- The global `document.querySelectorAll('[data-automation-id="promptOption"]')`
  lookup assumes only one moniker popup is open at a time. This holds today because
  fields are processed strictly sequentially (existing, tested invariant) and each
  field's popup is closed or superseded before the next one opens. Add a comment
  noting this, since it would silently break if processing ever became parallel.
- `closePopup()`'s Escape dispatch runs unconditionally on flag paths for this widget
  too, without separate confirmation it actually closes this specific popup — same
  unconfirmed-but-low-risk status as other widget variants already have.
- A future `data-uxi-widget-type="selectinput"` field that's neither variant still
  falls into the moniker path and simply gets flagged if no option matches — same
  safe failure mode as the rest of the pipeline.

## Testing

Extend `tests/combobox-fill.test.ts` with fixtures modeling this widget: a trigger
with `data-uxi-widget-type="selectinput"` and no `aria-haspopup`, with
`[data-automation-id="promptOption"]` elements appended somewhere in `document.body`
*outside* the trigger's own subtree, so the tests genuinely exercise the global-query
path rather than incidentally passing via containment. Cases:

- Successful fill via the global lookup (type+Enter fallback finds and clicks a
  matching option).
- Flags when no option matches the typed value.
- Flags and clears the typed value when no options ever render after the fallback.

Extend `tests/generic-adapter.test.ts` with a case confirming this input is
classified as `kind: 'combobox'`, not skipped or misclassified as plain text.

## Rollout

Same pattern as the last two combobox fixes: implement via subagent-driven
development, full test suite green, then merge to `main` before asking for manual
Workday verification (per the established rule that the loaded unpacked extension
always points at `main`, so testing before merge tests stale code).
