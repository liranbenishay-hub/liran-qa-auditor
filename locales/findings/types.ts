// Types for built-in finding content localization (Hebrew first).

export interface FindingLocaleEntry {
  issue?: string;
  whyItMatters?: string;
  suggestedFix?: string;
  found?: string;
  expected?: string;
  /** Evidence drawer — summary ("what the audit found") */
  evidenceSummary?: string;
  /** Evidence drawer — trigger reason ("why this finding was created") */
  evidenceTriggerReason?: string;
}

export type FindingParams = Record<string, string | number>;
