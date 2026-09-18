import { Profile } from '../storage/profile-schema';
import { flagField, setNativeValue } from './fill-engine';
import { normalize } from './synonym-dictionary';
import { FillSummary } from './types';

// Some ATS platforms (confirmed on Activision's career site) render repeatable experience rows
// the applicant never has to "add" — they already exist, pre-populated by the site's own
// resume-parse, using stable array-indexed ids like "experienceData[0].companyName". Unlike
// Workday/Oracle's dynamically-generated ids, these are directly addressable by index; there is no
// row to open, match by card identity, or save. The one thing resume-parse never fills is the
// free-text achievements/description field, so that is the only field this handles — matched to
// the correct profile entry by the row's own already-populated company/title rather than trusting
// row order, since resume-parse output order is not guaranteed to match the profile's.
//
// Uses getElementById (a raw string lookup) rather than a CSS id/attribute selector built from
// these ids: a selector like `[id^="experienceData["]` embeds a literal "[" inside the attribute
// value, which is valid CSS but broke real selector parsing (confirmed in jsdom) — getElementById
// takes the id as plain text and never parses it as a selector at all.
export function fillIndexedExperienceDescriptions(profile: Profile): FillSummary {
  let filled = 0;
  let flagged = 0;
  const indexes = new Set(
    Array.from(document.querySelectorAll<HTMLElement>('[id]'))
      .map((element) => element.id.match(/^experienceData\[(\d+)\]\./)?.[1])
      .filter((value): value is string => value !== undefined)
  );

  for (const index of indexes) {
    const descriptionField = document.getElementById(`experienceData[${index}].roleDescription`) as HTMLTextAreaElement | null;
    if (!descriptionField || descriptionField.value.trim()) continue;
    const company = normalize(
      (document.getElementById(`experienceData[${index}].companyName`) as HTMLInputElement | null)?.value ?? ''
    );
    const title = normalize(
      (document.getElementById(`experienceData[${index}].title`) as HTMLInputElement | null)?.value ?? ''
    );
    const entry = profile.workHistory.find((candidate) =>
      normalize(candidate.company) === company && normalize(candidate.title) === title
    ) ?? (company ? profile.workHistory.find((candidate) => normalize(candidate.company) === company) : undefined);

    if (entry?.description) {
      setNativeValue(descriptionField, entry.description);
      delete descriptionField.dataset.autofillFlag;
      descriptionField.style.outline = '';
      filled++;
    } else if (
      descriptionField.required ||
      descriptionField.getAttribute('aria-required') === 'true'
    ) {
      flagField(descriptionField);
      flagged++;
    }
  }

  return { filled, flagged };
}
