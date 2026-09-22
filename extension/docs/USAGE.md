# Using Job Autofill

## Persistent autofill control

Click the Job Autofill toolbar icon to show a small control card inside the application page. The
card stays visible while you interact with the form, including after **Save and Continue** changes
the current Workday step. Press **Autofill this page** again on every new step that needs filling.

The card is isolated from site styles with Shadow DOM and is positioned near the top-right so it
does not cover bottom navigation controls. Visibility is remembered per tab and restored after a
full page navigation. Close it with × and reopen it from the toolbar. It never clicks Save,
Continue, or final Submit buttons for you.

Chrome does not allow extensions to inject page UI into browser-owned pages such as
`chrome://extensions`, extension pages, or the Chrome Web Store. Clicking the toolbar icon on only
those protected pages opens **Edit profiles** instead. On every regular `http://` or `https://`
page—including unrecognized job sites—the toolbar still opens the in-page control card.

If an older popup still appears after updating the source, reload the unpacked extension from
`chrome://extensions`. Manifest permission and toolbar-behavior changes require an extension
reload.

## Check international fit

On a job-description page, open the control card and press **Check international fit**. The checker
runs locally and highlights wording about sponsorship, visas, citizenship, work authorization,
security clearances, U.S.-person restrictions, ITAR, and export controls. It also scrolls to the
first likely restriction.

- Red means the surrounding wording appears restrictive, such as “no visa sponsorship” or a
  citizenship requirement.
- Green means the wording appears supportive, such as sponsorship being available, or explicitly
  says citizenship or clearance is not required.
- Yellow means the term is relevant but the wording needs human review.

Press **Clear fit highlights** to restore the page. The result is a reading aid, not a definitive
eligibility decision: absence of highlighted wording does not mean the employer sponsors, and
export-control or clearance language can depend on the role and the applicant's status.

## Profile and review

Use **Edit profiles** to save reusable contact, experience, education, preference, and voluntary
disclosure answers. Give each tailored profile a name such as “Technical,” “Program Management,” or
“Consulting.” **Create as copy** duplicates the profile currently being edited so shared contact and
history data do not need to be re-entered. The Autofill card displays a profile selector and uses
the selected profile for that Autofill click and remembers it for later steps in the same tab.

Profiles can include an optional middle name. If it is blank, optional middle-name fields are left
alone rather than flagged. An optional Address line 2 that is blank in the profile is handled the
same way. Autofill leaves other missing, unsupported, or ambiguous answers for
manual review. Always review each step before continuing and complete legal attestations yourself.
Reusable yes/no settings also cover planned Optional Practical Training (OPT) and willingness to
work on-site when a role requires it. These are stored independently from sponsorship and
relocation because neither pair is logically interchangeable.

On iCIMS Candidate Profile pages, one Autofill click uploads the stored resume, waits for iCIMS to
reload its embedded form, and then fills the selected profile. Existing attachment names are
recognized so later Autofill clicks do not upload the resume again. Employer login passwords are
never stored, invented, or filled.

iCIMS EEO pages support Gender, Race/Ethnicity, Disability, and Veteran Status, including tenants
whose controls use only the labels `Disability` and `Veteran` and compact `Yes`/`No`/`Opt Out`
answers. Review iCIMS navigation carefully: some tenants register the application immediately when
a step-level **Submit** button is clicked and do not show a separate final-review screen.

iCIMS privacy-entry screens may also ask for email, phone country code, and phone number before
account creation. Those contact fields are supported, including country-code comboboxes that omit
`aria-haspopup`. Required privacy acknowledgments remain unselected and flagged for manual review;
Autofill never accepts legal notices or advances the form.

SmartRecruiters OneClick applications are supported through their nested SPL web components.
Autofill fills personal details, commits city/location autocomplete selections, uploads the resume
only to the real Resume control, and creates and saves the profile's work-experience and education
entries with their month/year dates. The separate “apply with resume” parser is intentionally left
alone so the same resume is not attached or parsed twice.

Apple Jobs Profile Information pages reconcile the selected profile with Apple's resume-parser
draft. Autofill clears a stale duplicate Address Line 2, creates missing education and employment
rows to match the profile, and commits school, field of study, degree, graduation status, employer,
job title, current-employer status, month/year dates, and multiline descriptions through Apple's
controlled form state. School, major, and employer accept the profile's exact custom text when the
Apple suggestion catalog lacks that exact value. Saved skills are split and added as individual
Apple skills, with the pending list confirmed once after all missing skills are staged. The optional
Profile Information supporting-file control is not the Add Resume control and never receives a
duplicate resume attachment. Preferred name remains optional when the profile leaves it blank.
Extra resume-parser rows are not deleted automatically; review and remove an unwanted unmatched row
yourself.

Oracle Recruiting Candidate Experience applications are supported for contact/address fields,
profile-backed questionnaire answers, voluntary disclosures, education, and work experience.
Oracle's month/year and graduation controls can replace their entire editor after every selection;
Autofill follows the newly rendered controls and waits for each option to commit before continuing.
Existing cards are matched by organization and role/major, missing profile entries are added once,
and unmatched resume-parser cards are highlighted for review rather than deleted automatically.
Tenant-specific questions without a saved profile answer remain highlighted for manual selection.
Source questions such as “Where did you hear about this position?” are the exception: Autofill
defaults them to `Company Website`. Dropdowns accept equivalent company careers-site wording (for
example, `Starkey Careers`); if no genuine company-site option exists, Autofill leaves the question
highlighted rather than selecting an unrelated job board, referral, or event.

Greenhouse-hosted applications support the official React Select controls used for phone country,
candidate location, school, degree, discipline, education month/year, employer questions, and
voluntary disclosures. Autofill opens each menu, searches when appropriate, clicks an exact option,
and verifies that Greenhouse committed it. If an exact school or major is absent, the control stays
highlighted for review instead of choosing a broader discipline. The standard Greenhouse Gender,
Hispanic/Latino, Race, Veteran Status, and Disability Status fields are recognized by their stable field
IDs even when their visible punctuation or wording varies.
Greenhouse also recognizes desired-start-date wording, sponsorship prompts that describe
commencing an immigration case, age eligibility, exact graduation year, current city,
work-on-site/relocation, identity-verification, prior-employer, non-compete/conflict, export-license
cooperation, OPT, and combined GPA-plus-degree prompts. A required free-text source question receives
`Company Website`; optional LinkedIn/Website fields
are left alone when no matching saved link exists, and Website can use the saved GitHub URL when no
portfolio URL is present.

ADP Workforce Now recruitment pages use MDF textboxes that erase values written before their
internal focus state finishes updating. Autofill handles these controls sequentially with a real
focus transition, an input transaction, blur/commit, and a final value check. This supports ADP's
guest contact fields and other labeled MDF text inputs. ADP's searchable address-country control is
also supported: Autofill opens its React Select listbox by keyboard, chooses an exact country, and
verifies the committed display value. Native dropdowns and choice controls remain on the shared
exact-match path. Autofill does not click ADP's Apply, Continue, verification, or submission buttons.

ADP's separate recruiting product on `recruiting.adp.com` (marketed as "Recruiting Management" or SRCCAR)
is a Dojo/Dijit application with its own adapter. Rather than simulating keystrokes, Autofill interacts
directly with the page's Dijit widget registry and uses the widget API to set values. It fills the Personal
Information fields (name, address, city, state, country, ZIP, phone), the mappable General Information
questions (willingness to relocate, right-to-work confirmation, minimum age), and a repeatable Employment
History section supporting up to six employer entries with one Autofill click creating additional rows by
clicking "Add Employer." Current roles are marked as such and leave their end-date and end-title fields
blank. Supervisor name, employer phone, contact permission, and reason for leaving are pulled from the
corresponding new fields in the work-history editor. Required fields without a saved value are highlighted
for manual review. Education, EEO/voluntary self-identification, and the eSignature step are not yet
supported, and Autofill never clicks Save, Next, or Submit.

UltiPro/UKG Recruiting application pages support saved contact, experience, education, resume,
start date, work authorization, sponsorship, non-compete, and voluntary-disclosure answers. When a
matching resume already exists in the candidate's Documents list, Autofill checks **Include in
application** instead of uploading a duplicate. UltiPro's UKG date component is edited through its
real month/day/year controls and verified after commit. Employer source defaults to a matching
company website/careers option, employee referral defaults to No, and tenant questions without a saved or
safe reusable answer remain available for review. Autofill never clicks the final application
submission button.

Optional employer-specific file inputs such as cover letters, work samples, and transcripts are
left alone when the profile has no matching document. A required unmatched attachment is still
highlighted for manual review. Stored resumes are attached only to recognized resume controls.

Workday voluntary disclosures support both accessible question labels and tenant controls that
identify Hispanic/Latino status only through their stable field name. Race/ethnicity matching also
recognizes the longer “ethnicity which most accurately describes how you identify yourself” wording.
Workday skills are split on commas, semicolons, or line breaks and committed as individual selected
items; legacy combined skill items created by earlier versions are repaired automatically. Education
Field of Study remains exact-match only, with `&` and `and` treated as equivalent conjunctions.
