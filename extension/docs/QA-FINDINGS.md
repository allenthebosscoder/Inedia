# Manual QA Findings — v1

## Persistent controls across application steps

**Status: ✅ Implemented 2026-08-06; revised after live verification and competitor research.** A
transient action popup cannot persist after clicking the page. Side-panel and standalone-window
attempts were rejected because they changed the page viewport or produced oversized browser UI.
The toolbar now reveals a compact Shadow-DOM control injected by a content script, matching the
in-page persistent-overlay pattern used by job-application copilots. Its visibility is stored per
tab, it survives Workday step changes and full navigations, and it retains host access so Autofill
continues working after **Save and Continue**.

## Workday Country / Territory Phone Code variant

**Status: ✅ Fixed and live-verified 2026-08-06.** A Workday-owned tenant labels the moniker field
`Country / Territory Phone Code`. Without that exact normalized synonym, the broad word `phone`
mapped the control to the applicant's phone number instead of `personal.phoneCountryCode`. The
dictionary now recognizes the tenant wording first. The combobox flow also accepts Workday's
asynchronously committed selected chip and moves focus to the next form control, leaving the correct
`United States of America (+1)` chip selected with the search UI collapsed.

Bugs found during the first real-browser test pass (loading the unpacked extension in Chrome and running Autofill against live job applications). These are written up for triage and future implementation planning, not fixed yet.

## Idea (not yet decided): don't flag optional fields

Raised during 2026-08-05 manual QA: should unmatched fields that aren't marked `required` on the page get skipped (no orange outline) instead of flagged, since they're lower-stakes than a required field the user might forget to fill in? Unresolved — deprioritized behind Bugs 2b and 4 for now. Worth a real design pass (what does "required" even mean across different ATS markup — `required` attribute, `aria-required`, visual asterisk?) before deciding, not a quick toggle.

## Bug 1: iCIMS pages are barely recognized

**Status: ✅ Fixed and live-verified 2026-08-20 on a Lennox iCIMS tenant.** The application form
lives in a tenant iframe alongside advertising, chat, tracking, and sandboxed frames. Injecting into
every frame as one operation allowed one restricted embed to abort the request before the real form
was reached. The background runner now enumerates frames and targets only the top document,
same-host frames, and iCIMS-owned frames; transient frame failures do not cancel the rest.

iCIMS also submits and replaces its candidate iframe immediately after a resume file is attached.
That navigation destroyed the first fill execution and left only values parsed from the resume. A
single Autofill click now performs a two-phase flow: upload the stored resume, wait for the replacement
candidate form to finish rendering, reinject the engine, and fill the saved profile without uploading
a duplicate attachment. The upload phase returns synchronously before iCIMS destroys the original
iframe, preventing the persistent widget from remaining stuck on **Filling…** after the fields are
already complete.

Live verification confirmed one-click upload and profile fill for login/email, first and last name,
phone type and number, address type, street address, city, ZIP, country, and state. Password fields
remain manual by design. An intentionally blank optional Address 2 field is no longer reported as
missing input.

The same Lennox flow exposed two follow-up issues, fixed and live-verified on 2026-08-21. Selecting
a tailored profile in the in-page widget was not persisted, so navigation to a later step could
silently restore the default profile. Widget radio changes and every Autofill run now store the
selected profile per tab. iCIMS EEO controls also use the bare labels `Disability` and `Veteran`,
with compact or truncated options (`Yes`/`No`/`Opt Out` and truncated disability sentences).
Those labels and controlled answer variants now map to the saved disclosure fields. Live QA filled
Gender, Race/Ethnicity, Disability, and Veteran Status in one pass with no remaining flags.

Tenant behavior note: on this flow, submitting the valid **Job Specific Questions** step immediately
registered the submission; there was no separate assessment or final-review confirmation even
though the progress indicator listed Assessments as the next step. Automated tests must treat any
iCIMS step-level **Submit** button as potentially final and stop for explicit review before clicking.

### Liberty Mutual iCIMS entry form — live QA 2026-08-21

This tenant begins with a GDPR/privacy screen containing Email, Phone Country Code, Number, and a
required legal acknowledgment. Its country-code trigger uses `role="combobox"` plus
`aria-controls`, but omits the commonly expected `aria-haspopup="listbox"`; the option list is
already mounted in a hidden container. The generic adapter now recognizes that accessible shape and
selects the exact `(+1) United States` option. The phone input's visible label is only `Number`, so
its unambiguous `phoneNumber`/`css_phoneNumber` metadata is used to map it to the saved phone.

Live verification from a clean form filled Email, Phone Country Code, and Phone Number in one pass.
The privacy acknowledgment remained unchecked and was the only flagged input; the disabled Next
button was not clicked. This preserves manual review for legal consent.

### Kimley-Horn iCIMS Candidate Profile — live QA 2026-08-21

One Autofill click uploaded the stored resume, waited for iCIMS to replace its Candidate Profile
iframe, then filled Login, First Name, Legal Last Name, Email, Phone Type, and Phone Number. The
password and confirmation inputs remained blank, and Submit Profile was not clicked. A stable rerun
recognized the existing resume and did not upload a duplicate.

The tenant's optional `Cover Letter / Work Samples` file input was initially reported as missing,
even though it was not required and the profile stores only a resume. Unsupported file inputs now
follow requiredness: optional employer-specific attachments are ignored and have stale flags
cleared, while required unmatched attachments remain flagged. Live verification ended with the
resume present, blank passwords, no flagged fields, and no submission.

### Peraton iCIMS privacy entry — live QA 2026-08-21

This tenant asks for Email plus two separate required legal acknowledgments: its general Privacy
Policy and a Peraton Job Application Privacy Notice. Autofill entered the saved email, left both
checkboxes unchecked, reported exactly those two items for manual input, and left Next disabled.
No tenant-specific source change was required and the form was not advanced.

---

## Bug 2: Workday select/dropdown fields don't fill reliably (e.g. State)

**Observed:** Workday "kinda works" overall (text fields fill), but select-style fields like State don't fill correctly.

**Expected:** Dropdown fields with a matching profile value should get selected, same as any other matched field.

**Confirmed cause (real DOM captured 2026-08-04):** Workday's State field is not a `<select>` at all — it's a `<button>`:

```html
<button aria-haspopup="listbox" type="button" value="1486a0a4a8464c3b9ec482d4038deb99"
  aria-label="State North Carolina Required" name="countryRegion" id="address--countryRegion"
  aria-expanded="true" aria-controls="vadg1y">North Carolina</button>
```

Since `extractFields`'s query is `input, select, textarea`, this button is never even seen by the extension — it's not "detected but mismatched," it's completely invisible to the current field scanner.

Clicking the button opens a popup listbox (the `aria-controls="vadg1y"` id points at it) containing the real options, standard WAI-ARIA listbox markup:

```html
<li data-value="1486a0a4a8464c3b9ec482d4038deb99" role="option" aria-selected="true"
  id="1486a0a4a8464c3b9ec482d4038deb99"><div>North Carolina</div></li>
```

This is a **standard ARIA combobox/listbox pattern** (`aria-haspopup="listbox"` + `aria-controls` + `role="option"` + `aria-selected`), not something Workday-proprietary in how it exposes state — good news, since a fix can target the ARIA semantics rather than reverse-engineered Workday-specific markup, and the same approach might generalize to other sites using the same accessible-widget convention.

Filling this requires a new kind of interaction the fill engine doesn't have yet — not a value-set, but a sequence: click the trigger to open the popup, wait for it to render, find the `[role="option"]` whose text matches the target value, click it.

**Also observed, a related but distinct pattern:** the Education → School field (`id="education-7--school"`, `data-uxi-widget-type="selectinput"`) is a *search* input, not a button-triggered listbox — typing into it does nothing until you press **Enter**, at which point a results list appears to pick from. Confirmed via user testing 2026-08-04. Haven't yet captured whether the popped-up results list uses the same `role="option"` markup as the State listbox — worth checking before designing the fix, since if it does, the "find and click the matching option" half of the logic can be shared between both interaction patterns; only the trigger step (click vs. type+Enter) differs.

**Suggested scope:** A new fill strategy in the fill engine for ARIA combobox/listbox widgets (click-or-type-to-open → wait → find matching `[role="option"]` → click), likely still needs Workday-specific *detection* (recognizing `aria-haspopup="listbox"` triggers and associating them with a profile field via `aria-label`) even if the interaction logic itself is generic. This is architecturally different from anything currently in the codebase — the fill engine has only ever done synchronous value-setting, not async click-wait-click sequences. Worth its own careful design pass, and worth designing together with Bug 4 (Education/School uses the same widget family).

**Status: ✅ Done — shipped 2026-08-05** (click-to-open State/Phone Device Type pattern). Real Workday manual QA after shipping found two follow-up bugs, both fixed the same day:
- `aria-controls` was read from the trigger *before* clicking it, but Workday doesn't attach that attribute until the popup actually mounts as a result of the click — so it was always `null` at read time, and the code bailed out (flagged) without ever attempting the click. The one captured DOM sample above didn't reveal this because it was captured mid-interaction, with the popup already open. Fixed by clicking first and re-reading `aria-controls` on every poll attempt.
- The synonym matcher does not yet distinguish "Country" from "State" when picking which field to interact with — not a bug in itself, but see Bug 5 below for a related sequencing concern.

**Bug 2b (type-then-Enter search widget, e.g. School): ✅ Done — shipped 2026-08-05** as the "search-combobox fallback" feature (spec/plan under `docs/superpowers/`). Handles the case where the trigger is a typeable `<input>` with standard ARIA semantics (`aria-haspopup="listbox"`, `role="option"` results) but requires typing + Enter instead of a bare click to populate the results. See Bug 7 below for a *different*, non-ARIA Workday widget that looks superficially similar but isn't covered by this fix.

---

## Bug 3: No "phone type" field support

**Observed:** Workday (and other ATS forms) ask for a separate "Phone Device Type" dropdown (Mobile / Home / Work / Other) alongside the phone number field. This is currently always flagged/unfilled.

**Expected:** Should fill with a sensible default (e.g. "Mobile") like the other profile fields.

**Cause:** The `Profile` schema (`src/storage/profile-schema.ts`) has no field for this, and the synonym dictionary has no matching entry — this is a straightforward missing-field gap, not a bug in existing logic.

**Suggested scope:** Small, well-contained fix — add a `personal.phoneType` field (with a default value, e.g. "Mobile"), a synonym dictionary entry, and select-matching support (reusing the existing `selectOptionByText` path from the final-review fix wave). Similar shape to the `workAuthorization` yes/no select fields already supported.

---

## Bug 4: Work history and education are never filled — needs to become a real feature, not a documented limitation

**Observed:** Nothing gets filled in for work experience or education sections. The user's expectation is that the extension should:
1. Detect and click the ATS's own "Add Work Experience" / "Add Education" button to create a new entry row (repeated once per stored entry), then
2. Fill each newly created row's fields (company, title, start/end date, description / school, degree, field of study, graduation date) from the corresponding `WorkHistoryEntry`/`EducationEntry` in the stored profile.

**Status: ✅ Fixed and live-verified 2026-08-06.** The background runner first performs small Add-only executions on My Experience until every required work and education editor exists, allowing React to mount each row without repeatedly filling the page. It then performs exactly one real autofill pass across the page. Other Workday steps and ordinary sites receive one fill pass only. A single Autofill click created and populated four employment histories and one education entry on the live MKS Workday tenant. Add controls are scoped to their section headings so Education cannot accidentally trigger Employment's “Add Another,” and both `school` and `schoolName` tenant variants are supported. Work fields include company, title, location, From/To month-year, current-role checkbox, and description; education includes school, mapped degree, field of study, dates, and GPA. School, Degree, and Field of Study use the search-combobox engine; a missing exact major remains flagged rather than selecting a potentially incorrect alternative.

Final live verification measured one input/change event per My Information field. On My Experience, one real background run created exactly four work editors and one education editor, filled them once, committed the first role's previously missing To date (`07/2026`), and uploaded the résumé once. The only remaining required field was the intentionally unmatched Field of Study.

A later Starfish tenant exposed a timing variant: selecting From remounted the work row slowly, so
the immediately following To selection could land on the detached row and disappear. Picker fills
now wait for the row remount, read the newly mounted month/year controls, and retry only the date
that failed to persist. A single live autofill pass then committed the saved `07/2026` end date with
no date validation error.

The remaining validation failure was traced to the picker target itself: Workday renders month
metadata on an outer `li[data-automation-id="monthPickerTile"]`, but the actual selection action is
owned by its inner `[role="button"]`. Clicking the outer tile could display `07/2026` while leaving
the parent form value empty. Clicking the inner control survived Save and Continue on the live
Starfish tenant and advanced to Application Questions with zero errors.

The persistent widget's Autofill button becomes a Stop button while these passes run. Cancellation takes effect between passes. Reloading an unpacked extension also replaces any orphaned widget DOM left by the invalidated content-script context, preventing the stale widget from reporting a generic autofill failure.

The toolbar action opens this persistent widget directly; it no longer opens a separate popup alongside it. Re-clicking the toolbar icon refreshes the same single-widget flow.

Live MKS application-question wording is covered for legal authorization, immigration-benefit sponsorship, and export-control “U.S. person” status. U.S. person is stored separately from U.S. citizenship because permanent residents, refugees, and asylees can qualify even when the citizenship answer is No; existing profiles leave the new answer blank for deliberate review.

Live verification on 2026-08-06 filled all three MKS controls with no flags or empty required fields. The toolbar opens the widget on recognized and unrecognized normal web pages. Chrome-protected pages such as `chrome://`, extension pages, and the Chrome Web Store cannot host injected extension UI, so toolbar clicks on only those pages open Edit Profiles instead.

The MKS Voluntary Disclosures step is also live-verified. Workday omitted every accessible label
from its Hispanic/Latino dropdown and exposed the meaning only in
`name="hispanicOrLatino"`/the element ID; ethnicity used the tenant-specific sentence “Please select
the ethnicity which most accurately describes how you identify yourself.” Metadata-label fallback
and the exact sentence mapping now fill the saved answers. The verified result was Hispanic/Latino
`No` and ethnicity `Asian (United States of America)`, with no flags, site errors, or empty required
fields.

On the Starfish questionnaire, the minimum-salary textarea exposed a second visual-only state bug:
its DOM value was `85000`, while Save and Continue still reported the field empty. Workday generic
text fields now use the browser editing path (`insertText` while focused) so its form model receives
the input. Live validation accepted the salary and advanced to Voluntary Disclosures. The exact
three-option disability checkbox group is covered separately; the saved “No” option was selected,
survived validation, and advanced the live application to Review without an error.

Another Starfish application made relocation appear to receive only a focus click: it ended with
Workday's blue outline and did not remain selected until Autofill was run a second time.
Live event tracing showed the option actually rendered "Yes" on the first pass, but a pending
page-wide React update restored "Select One" about 90 ms later. The combobox engine now waits for
the selection to settle, verifies the button still renders the saved answer, and repeats the
selection once after a rollback. It only reports the field as filled after that verification.
Already-selected Workday buttons are also recognized from their visible answer and left alone on
later Autofill runs. Popup polling and retry re-resolve the current trigger by ID in case Workday
remounts the control during an update.

The Workday corporate tenant exposed a separate search-state delay in Education. Autofill wrote
`Duke University` and pressed Enter 7 ms later; the selector returned `No Items.` even though the
same query returned Duke when entered manually. Live tracing showed this tenant debounces the text
into its internal search state. Moniker search fields now allow that state to settle before Enter,
covering School and Field of Study as well as other Workday search selectors. The tenant also
renders a transient `No Items.` option before streaming real matches into the portal. Autofill now
ignores that sentinel and waits for the exact saved value, avoiding both a false "not found" flag
and premature selection of a broader partial match such as `BA - Duke University`. These streamed
results attach Workday's selection handler to the `promptLeafNode`, not its outer ARIA option; a
click on the outer row leaves the field at `0 items selected`. Autofill now clicks that leaf and
verifies that a matching selected chip exists before reporting success.

The Ambarella Workday tenant was live-verified on 2026-08-27. Its Education list exposes
`Electrical and Computer Engineering` while the selected profile stores
`Electrical & Computer Engineering`; the conjunction-equivalence match committed the exact major
without enabling a broader discipline fallback. Workday's Skills control previously received the
entire comma-separated profile string as one item. Autofill now removes that legacy combined item
and commits each saved skill separately. The live page showed 22 distinct selected items with no
skills warning; this tenant canonicalized both saved `C++` and `C` to its single displayed `C`
choice.

The same Ambarella page exposed three questionnaire variants. Its restricted-country prompt adds
Sudan and asks about both citizenship and lawful permanent residency; the saved `No` answer safely
applies and was live-verified. Its single `Work Authorization` dropdown combines authorization and
sponsorship categories, so the profile's saved sponsorship requirement selects
`I require sponsorship to work in the U.S. (F1, H1, L1, J1)` rather than the inaccurate
Green Card/Citizen option. `What is your desired Annual Salary?` now maps to the saved minimum
salary and committed `85000`. Workday repeatable-section visibility also checks every ancestor so
hidden prior wizard steps are not mistaken for the active Experience page.

The Workday corporate questionnaire phrases reusable answers as "Would you consider relocating"
and "require any immigration filing or visa sponsorship to maintain work authorization." These now
map to the saved relocation and sponsorship answers. Export-control questions asking whether the
applicant is a citizen, national, or resident of an explicitly listed restricted country use a new
dedicated profile answer. The profile displays the complete Workday list (Iran, Cuba, North Korea,
Syria, Crimea, DNR, and LNR), and the matcher requires that list's fingerprint so the answer is not
reused for a different list. Autofill does not infer that legal status from U.S. citizenship, U.S.
person status, or the applicant's current address.

The North Carolina tenant adds a required County field and an optional Address Line 2 field. The
broad Address synonym previously copied Address Line 1 into both controls. Both are now separate
profile fields with exact mappings, and existing profiles migrate with the new values blank.

This tenant also uses the generic accessible label "Select One Required" on every questionnaire
button, with the real prompt in its fieldset legend. Autofill previously missed unsupported
required questions and occasionally misread words such as "State" inside a screening question as
an address field. Questionnaire buttons now retain their full legends for accurate flagging, while
short address-component mappings no longer match those words inside question prose.

Required supplemental multiple-choice questions can be rendered as checkbox groups rather than
radio buttons. Autofill previously applied its optional-checkbox rule to them, which was intended
only for toggles such as "I have a preferred name." Required checkbox fieldsets are now counted and
flagged once per unanswered question; a group with an existing checked answer is left untouched.
Workday's account Settings listbox is excluded from application fields, and hidden My Experience
controls retained after step navigation are not refilled or included in the missing-input count.
Unsupported Workday multiselects with an existing selected chip are also treated as satisfied; the
widget's intentionally empty search input is no longer reported as a missing answer.
Selected chips are scoped to their own Workday multiselect so an empty field cannot borrow a value
from another widget. Mobile phone profiles also match tenant variants such as "Home Cellular."
Unsupported radio questions with an existing checked answer are treated as satisfied as a group;
an unchecked option no longer creates a false missing-input count when its sibling is selected.
Degree mapping now includes category-only tenant labels such as Bachelors, Masters, Associates, and
Doctorate while retaining exact acronym/full-name matches as the preferred choices.
Work-authorization questions that ask about "employer support" or a work permit are recognized as
sponsorship questions even when the tenant never uses the word sponsorship.
Workday secondary-questionnaire dropdowns retain their full fieldset legends just like primary
questions, including conditionally mounted tenant questions.
NVIDIA-style disclosure prompts ("What is your ethnicity?" and "one of the following protected
veterans") map to the stored race/ethnicity and veteran-status answers.
Mapped Workday checkbox groups receive one bounded end-of-run stabilization pass after pending page
renders settle, preventing NVIDIA Self Identify from undoing the first disability selection.

**Why this is harder than the other bugs:** Unlike flat fields (name, email, phone), this requires:
- Detecting an "add entry" trigger button per site (very likely site-specific markup, not generically detectable the way flat-field labels are).
- Clicking it the right number of times (once per stored entry) and waiting for the new row's fields to render before filling them.
- Matching each newly-created row's fields to the correct stored entry by position/order.
- This is realistically going to need real per-adapter work (Greenhouse, Lever, Workday each render their "add another job" UI differently) rather than a single generic solution — closer in shape to Bug 2 than Bug 3.

**Current scope:** Workday is implemented first. Greenhouse, Lever, and LinkedIn repeatable-section behavior remains future adapter work and requires live fixtures for their Add controls and row markup.

---

## Bug 5: Phone Extension gets filled with the main phone number

**Observed (real Workday manual QA, 2026-08-05):** A "Phone Extension" field got filled with the user's phone number.

**Cause:** "phone" matches as its own whole word inside "Phone Extension", satisfying the synonym matcher's word-boundary check for `personal.phone` even though it's a genuinely different, unsupported field — there's no profile field for an extension number.

**Status: ✅ Done — shipped 2026-08-05.** Any label containing "extension" is now excluded from synonym matching entirely (`src/fill-engine/synonym-dictionary.ts`), so it's left flagged for manual entry instead.

---

## Bug 6: Country isn't filled, and State's options may depend on it

**Observed (real Workday manual QA, 2026-08-05):** On the tested application, Country defaulted to "United States of America" on its own, so State's option list was already correct. The user flagged that this can't be relied on — some Workday instances may not default Country, and State's available options are plausibly Country-dependent (a US state list won't apply, or won't even be the right *options*, until a country is chosen).

**Status: ✅ Done and manually verified 2026-08-05.** Added `personal.country`, defaulting to "United States," with Country/Country Region matching. "United States" preferentially selects Workday's exact "United States of America" option rather than "United States Minor Outlying Islands." Autofill fills Country first, then re-extracts the page so State and other country-dependent controls are filled from Workday's newly rendered DOM in the same run.

---

## Bug 7: Phone Country Code (and likely other Workday "moniker search box" fields) get filled as plain text, with no selection ever made

**Status: ✅ Done and manually verified 2026-08-05.** Fixed via a new detection query in `generic-adapter.ts` (`data-uxi-widget-type="selectinput"` inputs lacking `aria-haspopup`) and a per-field option-lookup strategy branch in `combobox-fill.ts` (global `[data-automation-id="promptOption"]` query for this widget family, vs. the existing `aria-controls`-scoped `[role="option"]` query for the ARIA pattern). The final verified interaction focuses the search input, types the query, submits it with Enter, selects the matching option, waits for Workday's post-selection render, and sends a real click-away-style pointer/mouse sequence so the menu closes. Live verification confirmed that Phone Country Code commits as a selected chip, the menu closes, and the adjacent Phone Device Type still fills.

**Observed (real Workday manual QA, 2026-08-05):** Phone Country Code shows "United States" typed into the box after autofill runs, but no option is ever actually selected — no orange "needs input" outline appears either, so the extension believes it succeeded.

**Investigation:** Initial hypothesis was that this field used the same ARIA combobox pattern as State/Phone Device Type (Bug 2) and School (Bug 2b), and that our synthetic `.click()` on the matched option wasn't registering because Workday's real handler listens for `mousedown`, not `click` — a common pattern to commit a selection before a blur/click-outside handler dismisses the popup. Shipped a fix (`clickWithoutDefault` now dispatches `mousedown`/`mouseup` before `click`) with a regression test reproducing a mousedown-driven widget. **This fix is real and correct for the ARIA-pattern widgets, but did not resolve this specific bug** — added temporary console logging and confirmed `fillComboboxFields` was never even being called for this field.

**Confirmed root cause:** This field is a fundamentally different, non-ARIA Workday widget — a "moniker search box" / multiselect input (`data-uxi-widget-type="selectinput"`, `data-automation-id="searchBox"`, wrapped in containers with `data-automation-id="monikerSearchBox"` / `"multiselectInputContainer"` / `"multiSelectContainer"`). Traced the *entire* ancestor chain from the `<input>` up to `<html>` — no element anywhere carries `aria-haspopup`, `role`, or `aria-controls`:

```html
<input enterkeyhint="search" dir="ltr" placeholder="Search" aria-invalid="false"
  aria-describedby="0bd1ad0c-c967-42d6-9b37-4c35c11fad94" aria-disabled="false"
  aria-required="true" autocomplete="off" tabindex="0"
  data-uxi-widget-type="selectinput" data-uxi-multiselect-id="ce86d5e5-f42d-4910-bf6d-c49724c5b589"
  id="phoneNumber--countryPhoneCode" value="United States" data-automation-id="searchBox">
```

Its result options also use different markup than the ARIA pattern — `data-automation-id="promptOption"` instead of `role="option"`:

```html
<div id="promptOption-30776526-3f0a-421c-90ef-c15a9d522b6d" data-automation-id="promptOption"
  data-automation-label="United States of America (+1)" class="css-veag3t">United States of America (+1)</div>
```

Because neither our combobox-detection query (`[aria-haspopup="listbox"]`) nor the option-finding query (`[role="option"]`) can ever match this widget, the field falls through to the plain native `input`/`select`/`textarea` query and gets treated as an ordinary text field — filled via bare `setNativeValue`, with no selection logic involved at all. That fully explains the symptom: text appears, nothing gets selected, and no flag is shown (as far as the fill engine is concerned, a text field was successfully filled).

**Implemented shape:** Detection and interaction are keyed off `data-automation-id`/`data-uxi-widget-type`; options are matched through the globally mounted `[data-automation-id="promptOption"]` portal. The same mechanism is reusable by repeatable Education search fields when Workday exposes them as moniker widgets.

---

## Bug 8: Hidden inputs can be reachable as combobox triggers (no `type="hidden"` check anywhere in detection)

**Raised during final review of the Bug 7 fix (2026-08-05), not yet observed on real Workday.** `isFillable` in `src/fill-engine/generic-adapter.ts` checks `disabled`, `readOnly`, the `hidden` property, and inline `display`/`visibility` styles — but never checks `input.type === 'hidden'`. A hidden input's invisibility comes from the browser's default stylesheet, not an inline style or the `hidden` attribute, so `isFillable` currently treats `<input type="hidden">` as fillable.

**Why this matters:** Both combobox-trigger detection queries (`[aria-haspopup="listbox"]` and, as of the Bug 7 fix, the moniker-widget selector) could match a hidden input if one existed with those attributes — Workday widgets commonly pair a visible search box with a hidden value-holding input, so this isn't a far-fetched shape. If it happened, the extension would click, type into, and flag an element the user can never see or act on, inflating the "needs input" count with something invisible.

**Current state:** Not reproduced — no real Workday page has shown this yet. Pre-existing gap in `isFillable`, not something the Bug 7 work introduced; it just became more reachable once combobox detection grew a second query. Affects the ARIA-pattern combobox detection equally, not just the moniker pattern.

**Suggested scope:** Small, contained fix — add a `type === 'hidden'` check to `isFillable` (or to the trigger-selector queries directly, e.g. `:not([type="hidden"])`). Worth confirming with a real captured example first if one turns up during manual QA, but the fix is cheap enough to do proactively too.

---

## Summary for planning

### ADP Workforce Now — implementation started 2026-08-26

The WRA ADP guest-contact screen exposed a false-success pattern: the generic engine reported first
name, last name, and email as filled, while ADP immediately restored all three to blank. Inspection
of ADP's published MDF TextBox source confirmed that the component derives its value from props
until an internal asynchronous `hasFocus` state is set; writing in the same JavaScript turn as
focus therefore loses the value. ADP now has a dedicated adapter and sequential text filler that
performs a focus transition, waits for the component render boundary, sends the input transaction,
blurs to dispatch MDF's model update, and verifies the live value before counting success.

The guest screen was live-verified with first name, last name, email, formatted phone, and United
States phone country visible. Its `Phone number country` label previously matched the broader
`phone number` synonym and is now mapped to phone country code before the phone field. The live run
did not click Continue or upload a resume. Further ADP application-step QA is still required after
the site's guest verification/navigation step; this entry does not claim repeatable work history or
education support yet.

The authenticated Personal Information step exposed a second ADP-specific control: address Country
is a React Select input with `aria-haspopup="true"`, not the standard `listbox` value. Treating it as
text left the input blank. The ADP filler now opens the real listbox with Arrow Down, scopes options
through the live `aria-controls` ID, clicks an exact profile country, and verifies
`.MDFSelectBox__single-value`. A live empty-state run committed `United States`; the hidden required
validation proxy is no longer counted as a separate unfilled field. Optional Address Line 3 is also
left blank rather than receiving a duplicate of Address Line 1.

### Starkey UltiPro/UKG tenant — live QA 2026-08-26

The Firmware Engineer I application was exercised without final submission. The generic pass had
already populated contact information, four work experiences, one education entry, desired salary,
gender, veteran status, disability status, signature name, and signature date. The dedicated
UltiPro pass then selected the existing stored resume for inclusion without uploading it again,
selected the first available source and No employee referral, and committed non-compete, current
employee, U.S. work authorization, and future sponsorship answers.

UltiPro's available-start-date control is a UKG web component whose actual month, day, and year
inputs live in an open shadow root. Writing its visible `value` attribute does not update the
component model. Autofill now edits those three controls with composed input/change transactions,
blurs each segment, and verifies the host committed the profile date. The live component committed
May 3, 2027. Hispanic/Latino, Race (Asian), gender, and veteran status were also verified through
their native selects. Optional prefix, middle name, suffix, secondary phone, resume chooser,
description, and voluntary-decline controls are excluded from false missing-input counts. A final
read-only audit found no visible stale autofill warnings.

### Verkada Greenhouse tenant — live QA 2026-08-25

The Verkada Backend Software Engineering Intern 2027 application was exercised without resume
upload or submission. One Autofill pass committed 18 profile-backed fields, including phone country,
candidate location, Duke University, bachelor's degree, education end month/year, graduation range,
GPA range, internship season, and all four standard voluntary-disclosure dropdowns. Greenhouse's
phone-country control was verified separately because its menu option reads `United States +1` but
its committed display intentionally contracts to `+1`.

The live page exposed Greenhouse's official React Select behavior: its inputs use
`aria-haspopup="true"` rather than `aria-haspopup="listbox"`, obtain `aria-controls` only after the
menu opens, and toggle from a mouse-up handler on the control wrapper. The dedicated filler now uses
that interaction, scopes options to the newly mounted listbox, clicks and verifies the exact option,
and closes menus with Greenhouse's Escape key-up path. The generic extractor excludes these controls
so it cannot leave uncommitted search text in them.

Verkada does not offer the exact saved major, Electrical and Computer Engineering, so Autofill did
not substitute generic Engineering or Computer Science. The temporary QA profile had no LinkedIn
URL; optional blank link fields are now left alone without a false missing-input warning. Automated
coverage reproduces the official menu lifecycle, the shortened `+1` committed display, all standard
EEO IDs, degree/date/GPA mappings, and the exact-major failure behavior.

### Relay Greenhouse tenant — live QA 2026-08-26

The Associate Software Engineer, Embedded Development application was exercised without resume
upload or final submission. The first pass took over a minute because unsupported Relay questions
were left for review before the generic text phase began. The updated pass completed in roughly six
seconds and reported 18 filled fields with zero warnings. A final read-only audit found no required
blank fields.

The page introduced reusable work-on-site and Optional Practical Training questions, now stored as
their own profile answers rather than inferred from relocation or sponsorship. Relay's sponsorship
prompt describes the employer commencing an immigration case, and its start-date prompt asks for a
“desired” date; both wording variants now map to their existing saved answers. The combined prompt
requesting cumulative GPA and degree received `4, BS`, salary received `85000`, source received
`LinkedIn`, and the on-site, work-authorization, sponsorship, and OPT controls all committed `Yes`.
Optional LinkedIn and Website fields no longer produce warnings when the selected profile has no
saved link; Website prefers Portfolio and can fall back to GitHub.

After these live checks, source handling was standardized across adapters: source questions now
default to `Company Website` or a tenant-equivalent careers-site option. If a dropdown has no such
option, it remains highlighted for review instead of selecting an unrelated first item.

### Axon Greenhouse tenant — live QA 2026-08-27

The 2027 US Electrical Engineering Internship application was exercised without resume upload or
submission. A final DOM/React audit confirmed 25 committed fills and one intentional warning. The
committed values included Duke University, bachelor's degree, August 2024 through 2027 education
dates, Durham location, age eligibility, on-site/relocation preference, work authorization,
sponsorship, identity/work-authorization verification, export-license cooperation, contractual
obligations, prior Axon employment, and all saved voluntary disclosures including Asian race.

This tenant exposed delayed remote School results and several custom question phrasings. Greenhouse
selection now waits for a stable async result set instead of treating the initial unfiltered menu as
final. The adapter also distinguishes an export-license cooperation question from U.S.-person
status, derives exact graduation year and prior-employer answers, fills the current-city text input,
and maps an on-site applicant who is willing to relocate to `I am open to relocation with
assistance` when that is the tenant's available answer rather than a plain Yes/No choice.

Discipline remained highlighted: the tenant never returned the exact saved `Electrical & Computer
Engineering` option. Autofill deliberately did not replace it with a nearby discipline. Regression
coverage reproduces the Axon age, graduation, city, on-site, verification, export, conflict,
previous-employer, and race controls.

### Nokia Oracle Recruiting tenant — live QA 2026-08-25

The Nokia Candidate Experience page was exercised without final submission. Autofill corrected the
education end date to May 2027, added the missing Zhang Lab and Duke University teaching-assistant
roles exactly once, preserved the existing Duke Electric Vehicles and Singapore Armed Forces
entries, and committed Oracle's country and month/year dropdowns without leaving an editor open.

The same pass filled Title, academic level, expected graduation day/month/year, GPA eligibility,
work authorization, enrollment/transcript, non-compete, prior-employer, government-employment,
disability, Asian race/ethnicity, and gender answers. A live regression exposed two Oracle render
patterns now covered by tests: the editor element is replaced after a date or checkbox interaction,
and a dropdown can show the committed value while retaining stale expanded state or delaying its
commit after the option click. Selection now requeries the live editor, accepts exact rerendered
values, waits for delayed commits, and enforces an elapsed-time ceiling.

The tenant-specific source question remains manual because the profile has no truthful reusable
answer. An unmatched Mitzi Lab resume-parser card was highlighted but not automatically deleted.
This is deliberate: an extension rerun must never silently erase application history it cannot map.

### Shaw Industries Workday tenant — live QA 2026-08-19

The seven-step Shaw application was completed through Review without final submission. Autofill
successfully populated the personal-information page, four work experiences, one education entry,
resume, work authorization and sponsorship, Hispanic/Latino status, and the full disability form.
Workday accepted every saved page without required-field validation errors. The exact major was
not available in Shaw's field-of-study list, so it correctly remained flagged instead of selecting
an unintended fallback.

This tenant exposed three reusable issues that are now covered:

- Optional prompts for additional, alternate, or secondary phone numbers no longer receive the
  saved primary phone number.
- Workday ethnicity checkbox groups are mapped from their group metadata and can select the saved
  race/ethnicity even though each checkbox's direct label is an answer rather than a question.
- Shaw's "identify as one or more protected veteran categories" wording maps to veteran status;
  the existing non-veteran fallback can therefore select "No, I am not a Protected Veteran."

The live test application was corrected to show "No Response" for the optional additional-phone
question and reached Review cleanly. Regression tests cover the new mappings. The ATS controller
also now targets Chrome's active tab directly, and its diagnostics treat a required checkbox/radio
fieldset as satisfied when one of its options is checked.

### Apple Jobs — adapter QA 2026-08-29

The Software Engineering Systems Profile Information step exposed stale resume-parser data rather
than a blank form: Address Line 1 was duplicated into optional Line 2, two majors were merged,
employment history belonged to a different tailored profile, and one saved role was absent. Apple
also uses the same typeahead presentation for School, Field of Study, Employer, and Add Skill, while
its source code confirms those controls are non-strict and commit custom text on blur or Enter.

A dedicated Apple adapter now adds any missing education and employment rows and verifies every live
controlled value after Apple rerenders it. Current roles mount no end
date; completed roles receive both end selectors. Skills are staged one at a time and confirmed in
one batch. Optional preferred name, the blank second address line, and Apple's supporting-file input
are handled without false warnings or duplicate resume upload. Automated coverage includes the
controlled typeaheads, bachelor's-degree mapping, current/completed employment dates, multiline job
descriptions, individual skill staging, and Apple-specific field exclusion. After explicit approval,
the selected Custom profile was run on the live page without advancing it. The final read-only audit
confirmed Duke Electric Vehicles / Power Systems Lead, Zhang Lab / Research Intern, Pratt School of
Engineering / ECE Teaching Assistant, the exact saved Electrical & Computer Engineering major,
correct current/completed month-year dates, blank Address Line 2, and all 23 individual skill rows.
There were no remaining autofill flags or pending skill pills, and Apple's Continue button was not
clicked. The live run also exposed Apple's pending-pill label `Remove Verilog` (rather than
`Remove Skill Verilog`), which is now covered by the verifier and regression test. Extra
resume-parser rows are preserved for manual review rather than silently deleted.

### ADP Recruiting (recruiting.adp.com) — adapter added 2026-08-31

`recruiting.adp.com` applications previously received no autofill support. The extension had an adapter
for `workforcenow.adp.com` (a different, React-based ADP product), but `recruiting.adp.com` uses
Dojo/Dijit widgets that do not respond to plain DOM value writes—the generic engine would report a
field as filled while leaving it visually empty. A new `adp-recruiting` adapter now queries the page's
Dijit widget registry from the MAIN world and fills fields through the widget API. The implementation
covers a flat Personal Information pass (name, address fields, city, state, country, ZIP, phone), a
General Information pass with mappable questions (willingness to relocate, right-to-work confirmation,
age confirmation), and a repeatable Employment History section supporting up to six employer entries,
with "Add Employer" clicks for rows not yet present. Current roles are marked as such and skip their
end-date and end-title fields. Employer phone, supervisor name, may-we-contact flag, and reason for
leaving are sourced from new `WorkHistoryEntry` fields now visible in the options work-history editor.
Required fields without a saved answer are highlighted for review.

Not yet verified against a live `recruiting.adp.com` application. Multiple assumptions still need
real-page verification: the Dijit widget API's exposed methods (`getOptions`, `_handleOnChange`), the
"Add Employer" button text and timing for row registration, the actual `<select>` option values used
by the page, whether `employerReference` maps to the "May We Contact?" control, and that newly added
Employment History rows register their Dijit widgets before the fill phase queries them. Location
parsing assumes the format `City, State, Country`. Education, EEO/voluntary self-identification, and
the eSignature step are explicitly out of scope for this pass.

| Bug | Complexity | Likely fix shape |
|---|---|---|
| 1. iCIMS barely recognized | Medium — needs investigation first | Generic-adapter improvement, maybe new adapter |
| 2. Workday click-to-open dropdowns (State, Phone Device Type) | — | ✅ Done — shipped 2026-08-05 |
| 2b. Workday type-then-Enter ARIA search widgets (School) | — | ✅ Done — shipped 2026-08-05 |
| 3. Missing phone type field | Small | ✅ Done — shipped 2026-08-04 |
| 4. Work history/education not filled | — | ✅ Fixed and live-verified on Workday 2026-08-06 |
| 5. Phone Extension filled incorrectly | Small | ✅ Done — shipped 2026-08-05 |
| 6. Country not filled; State may depend on it | — | ✅ Done and manually verified 2026-08-05 |
| 7. Phone Country Code (non-ARIA "moniker search box") filled as plain text | — | ✅ Done and manually verified 2026-08-05 |
| 8. Hidden inputs reachable as combobox triggers | Small — not yet reproduced | Add a `type="hidden"` check to `isFillable`/trigger selectors |

Bug 1 still needs a real captured HTML fixture from the live site. Bug 8 needs a real captured example before it's worth prioritizing.
