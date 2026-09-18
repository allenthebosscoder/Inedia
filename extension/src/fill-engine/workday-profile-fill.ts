import { Profile } from '../storage/profile-schema';
import { normalize } from './synonym-dictionary';
import { FillSummary } from './types';
import { fillComboboxFields } from './combobox-fill';

function clearFlag(element: HTMLElement): void {
  delete element.dataset.autofillFlag;
  element.style.outline = '';
}

function questionFor(input: HTMLInputElement): string {
  const fieldset = input.closest('fieldset');
  if (fieldset) return (fieldset.innerText || fieldset.textContent || '').replace(/\s+/g, ' ').trim();
  let node: HTMLElement | null = input.parentElement;
  for (let depth = 0; node && depth < 6; depth++, node = node.parentElement) {
    const text = (node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim();
    if (/previously worked/i.test(text)) return text;
  }
  return '';
}

function previousEmployer(question: string): string | null {
  return question.match(/previously worked[\s\S]*?\bfor\s+(.+?)\?/i)?.[1]?.trim() ?? null;
}

function questionForButton(button: HTMLButtonElement): string {
  const legend = button.closest('fieldset')?.querySelector<HTMLElement>(':scope > legend');
  return (legend?.innerText || legend?.textContent || '').replace(/\s+/g, ' ').trim();
}

function mentionsSavedEmployer(profile: Profile, question: string): boolean {
  const normalizedQuestion = normalize(question);
  return profile.workHistory.some((entry) => {
    const company = normalize(entry.company);
    return company.length >= 3 && normalizedQuestion.includes(company);
  });
}

async function fillEmployerHistoryDropdowns(profile: Profile, root: ParentNode): Promise<FillSummary> {
  const buttons = Array.from(root.querySelectorAll<HTMLButtonElement>(
    'button[id^="primaryQuestionnaire--"][aria-haspopup="listbox"]'
  ));
  let filled = 0;
  let flagged = 0;
  for (const button of buttons) {
    if (button.value || !/^select one$/i.test((button.textContent || '').trim())) continue;
    const question = questionForButton(button);
    if (!/(?:previously worked|contingent work|contractor)/i.test(question)) continue;
    const answer = mentionsSavedEmployer(profile, question) ? 'Yes' : 'No';
    const syntheticProfile: Profile = {
      ...profile,
      personal: { ...profile.personal, city: answer },
    };
    const summary = await fillComboboxFields([{
      element: button,
      label: question,
      kind: 'combobox',
      profileKey: 'personal.city',
      candidates: [answer],
    }], syntheticProfile);
    filled += summary.filled;
    flagged += summary.flagged;
  }
  return { filled, flagged };
}

export async function fillWorkdayProfileQuestions(
  profile: Profile,
  root: ParentNode = document
): Promise<FillSummary> {
  const radios = Array.from(root.querySelectorAll<HTMLInputElement>(
    'input[type="radio"][name="candidateIsPreviousWorker"]'
  ));
  let radioSummary: FillSummary = { filled: 0, flagged: 0 };
  if (radios.length > 0) {
    const employer = previousEmployer(questionFor(radios[0]));
    if (employer) {
      const targetEmployer = normalize(employer);
      const previouslyWorkedThere = profile.workHistory.some((entry) => {
        const company = normalize(entry.company);
        return company === targetEmployer || company.includes(targetEmployer) || targetEmployer.includes(company);
      });
      const desired = String(previouslyWorkedThere);
      const target = radios.find((radio) => normalize(radio.value) === desired) ??
        radios.find((radio) => {
          const label = document.querySelector(`label[for="${CSS.escape(radio.id)}"]`)?.textContent ?? '';
          return normalize(label) === (previouslyWorkedThere ? 'yes' : 'no');
        });
      if (target) {
        if (!target.checked) target.click();
        radios.forEach(clearFlag);
        radioSummary = { filled: 1, flagged: 0 };
      }
    }
  }
  const dropdownSummary = await fillEmployerHistoryDropdowns(profile, root);
  return {
    filled: radioSummary.filled + dropdownSummary.filled,
    flagged: radioSummary.flagged + dropdownSummary.flagged,
  };
}
