import type { LangCode } from "../index";
import type { FindingLocaleEntry, FindingParams } from "./types";
import { heFindingContent, heEvidenceSignalLabels, heEvidenceNotes, heEvidenceHeuristic } from "./he";

export type { FindingLocaleEntry, FindingParams };

/** Interpolate {{key}} placeholders — dynamic website values stay as-is. */
export function interpolate(template: string, params?: FindingParams): string {
  if (!params) return template;
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) =>
    params[key] !== undefined ? String(params[key]) : `{{${key}}}`
  );
}

function getEntry(lang: LangCode, ruleKey: string): FindingLocaleEntry | undefined {
  if (lang === "he") return heFindingContent[ruleKey];
  return undefined;
}

export interface LocalizableFinding {
  ruleKey?: string;
  params?: FindingParams;
  issue: string;
  whyItMatters: string;
  suggestedFix: string;
  found?: string;
  expected?: string;
  category: string;
  effort: string;
  impact: string;
  priority: string;
}

export interface LocalizedFindingFields {
  issue: string;
  whyItMatters: string;
  suggestedFix: string;
  found?: string;
  expected?: string;
}

/** Translate built-in finding content. Falls back to English for RU/ES/missing keys. */
export function localizeFindingFields(
  finding: LocalizableFinding,
  lang: LangCode
): LocalizedFindingFields {
  if (lang === "en" || !finding.ruleKey) {
    return {
      issue: finding.issue,
      whyItMatters: finding.whyItMatters,
      suggestedFix: finding.suggestedFix,
      found: finding.found,
      expected: finding.expected,
    };
  }

  const entry = getEntry(lang, finding.ruleKey);
  if (!entry) {
    return {
      issue: finding.issue,
      whyItMatters: finding.whyItMatters,
      suggestedFix: finding.suggestedFix,
      found: finding.found,
      expected: finding.expected,
    };
  }

  const params = finding.params;
  return {
    issue: entry.issue ? interpolate(entry.issue, params) : finding.issue,
    whyItMatters: entry.whyItMatters ? interpolate(entry.whyItMatters, params) : finding.whyItMatters,
    suggestedFix: entry.suggestedFix ? interpolate(entry.suggestedFix, params) : finding.suggestedFix,
    found: entry.found ? interpolate(entry.found, params) : finding.found,
    expected: entry.expected ? interpolate(entry.expected, params) : finding.expected,
  };
}

export interface EvidenceSignal {
  label: string;
  value: string;
  status: "good" | "warning" | "critical" | "neutral";
  note?: string;
}

export interface LocalizableEvidence {
  summary: string;
  signals: EvidenceSignal[];
  triggerReason: string;
  dataSource: "real" | "heuristic";
}

/** Translate evidence drawer explanations. Signal values (detected page text) stay unchanged. */
export function localizeEvidence(
  ev: LocalizableEvidence,
  ruleKey: string | undefined,
  lang: LangCode,
  params?: FindingParams
): LocalizableEvidence {
  if (lang === "en") return ev;

  if (ev.dataSource === "heuristic") {
    return {
      ...ev,
      summary: heEvidenceHeuristic.summary,
      triggerReason: heEvidenceHeuristic.triggerReason,
      signals: ev.signals.map((s) => ({
        ...s,
        label: heEvidenceSignalLabels[s.label] ?? s.label,
      })),
    };
  }

  const entry = ruleKey ? getEntry(lang, ruleKey) : undefined;

  return {
    ...ev,
    summary: entry?.evidenceSummary
      ? interpolate(entry.evidenceSummary, params)
      : ev.summary,
    triggerReason: entry?.evidenceTriggerReason
      ? interpolate(entry.evidenceTriggerReason, params)
      : ev.triggerReason,
    signals: ev.signals.map((s) => ({
      ...s,
      label: heEvidenceSignalLabels[s.label] ?? s.label,
      note: s.note ? (heEvidenceNotes[s.note] ?? s.note) : undefined,
    })),
  };
}

/** Category display names */
const CATEGORY_HE: Record<string, string> = {
  "Product Clarity": "בהירות מוצר",
  "User Journey": "מסע משתמש",
  Conversion: "המרה",
  "UX Friction": "חיכוך UX",
  "Trust Signals": "אותות אמון",
  Accessibility: "נגישות",
  "Mobile Experience": "חוויית מובייל",
  "Performance Perception": "תפיסת ביצועים",
};

const PRIORITY_HE: Record<string, string> = {
  urgent: "דחוף",
  important: "חשוב",
  later: "מאוחר יותר",
};

const EFFORT_HE: Record<string, string> = {
  Low: "נמוך",
  Medium: "בינוני",
  High: "גבוה",
};

const IMPACT_HE: Record<string, string> = {
  Low: "נמוכה",
  Medium: "בינונית",
  High: "גבוהה",
};

export function localizeCategory(category: string, lang: LangCode): string {
  return lang === "he" ? (CATEGORY_HE[category] ?? category) : category;
}

export function localizePriority(priority: string, lang: LangCode): string {
  return lang === "he" ? (PRIORITY_HE[priority] ?? priority) : priority;
}

export function localizeEffort(effort: string, lang: LangCode): string {
  return lang === "he" ? (EFFORT_HE[effort] ?? effort) : effort;
}

export function localizeImpact(impact: string, lang: LangCode): string {
  return lang === "he" ? (IMPACT_HE[impact] ?? impact) : impact;
}

const CONFIDENCE_REASON_HE: Record<string, string> = {
  high: "ראיות DOM ישירות מאשרות ממצא זה. הערכים המדויקים נקראו מהעמוד החי.",
  medium: "מספר אותות מהעמוד החי תומכים בממצא זה. חלק מהזיהוי מסתמך על התאמת תבניות.",
  low: "ממצא זה נתמך באותות חלקיים. אישור ישיר דורש בדיקת עמוד מעמיקה יותר.",
};

const CONFIDENCE_LEVEL_HE: Record<string, string> = {
  high: "ביטחון גבוה",
  medium: "ביטחון בינוני",
  low: "ביטחון נמוך",
};

export function localizeConfidenceReason(level: "high" | "medium" | "low", lang: LangCode): string {
  return lang === "he" ? CONFIDENCE_REASON_HE[level] : "";
}

export function localizeConfidenceLevel(level: "high" | "medium" | "low", lang: LangCode): string {
  if (lang !== "he") return level === "high" ? "High confidence" : level === "medium" ? "Medium confidence" : "Low confidence";
  return CONFIDENCE_LEVEL_HE[level];
}

export function localizeConfidenceSignalLabel(label: string, lang: LangCode): string {
  if (lang !== "he") return label;
  return heEvidenceSignalLabels[label] ?? label;
}
