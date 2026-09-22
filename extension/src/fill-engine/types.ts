import { ProfileFieldKey } from '../storage/profile-schema';

export type FieldKind = 'text' | 'textarea' | 'select' | 'radio' | 'checkbox' | 'file' | 'combobox';

export interface FieldDescriptor {
  element: HTMLElement;
  label: string;
  kind: FieldKind;
  profileKey: ProfileFieldKey | null;
  candidates?: string[];
}

export interface Adapter {
  id: string;
  matchesHostname(hostname: string): boolean;
  extractFields(root: ParentNode): FieldDescriptor[];
}

export interface FillSummary {
  filled: number;
  flagged: number;
  // Optional, populated only for the top-level run summary: names of profile skills that could
  // not be matched to a real Workday catalogue entry (a genuine gap, not a bug — see
  // combobox-fill.ts's tenant-branded/exact/fuzzy tiers) so the applicant can see exactly which
  // ones to add by hand instead of having to dig through a diagnostic dump to find out.
  flaggedSkills?: string[];
}
