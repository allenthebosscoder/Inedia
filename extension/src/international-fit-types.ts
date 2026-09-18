export type InternationalFitCategory = 'restrictive' | 'supportive' | 'review';

export interface InternationalFitSummary {
  restrictive: number;
  supportive: number;
  review: number;
  total: number;
  cleared?: boolean;
}

