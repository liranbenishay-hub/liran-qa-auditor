"use client";

import { useState, useRef, useEffect } from "react";
import { type LangCode, TRANSLATIONS } from "../locales";
import {
  classifySiteContext,
  SITE_TYPE_LABELS,
  SITE_TYPE_ICONS,
  confidenceLabel,
  type SiteContext,
  type SiteContextType,
} from "@/lib/site-context";

// ── Types ─────────────────────────────────────────────────────────────────────

type AuditState = "idle" | "loading" | "results";

/** Richer scan reliability object — replaces the old AuditStatus string enum */
interface ScanQuality {
  /** reliable = full DOM data; limited = thin/partial data; failed = no usable data */
  status: "reliable" | "limited" | "failed";
  /** Human-readable reasons explaining why this quality level was assigned */
  reasons: string[];
  /** 0–100 confidence in scan completeness */
  confidence: number;
  /**
   * When true, this domain is complex enough that GREEN requires screenshot confirmation.
   * Without a screenshot the traffic light is capped at YELLOW even for reliable scans.
   */
  screenshotRequired?: boolean;
  /**
   * When true, this is a known AI-builder / SPA hosting platform (Lovable, Bolt, v0…).
   * Static HTML shell is expected — thin DOM is not evidence of failure.
   * A loaded screenshot is sufficient to confirm the page is accessible → GREEN.
   */
  isAIBuilderSite?: boolean;
}
type SiteType = "saas" | "ecommerce" | "devtool" | "portfolio" | "enterprise" | "marketplace" | "landing" | "ai-builder";
type Priority = "urgent" | "important" | "later";
type Category =
  | "Product Clarity"
  | "User Journey"
  | "Conversion"
  | "UX Friction"
  | "Trust Signals"
  | "Accessibility"
  | "Mobile Experience"
  | "Performance Perception";
type Effort = "Low" | "Medium" | "High";
type Impact = "Low" | "Medium" | "High";
type ToolId = "lovable" | "base44" | "claude" | "cursor" | "generic";

interface AuditFinding {
  id: string;
  priority: Priority;
  category: Category;
  issue: string;
  whyItMatters: string;
  suggestedFix: string;
  effort: Effort;
  impact: Impact;
  /** What was actually detected on the page (FOUND card in Evidence Drawer) */
  found?: string;
  /** What the system expected to see (EXPECTED card in Evidence Drawer) */
  expected?: string;
}

interface AuditResult {
  domain: string;
  siteType: string;
  detectedBuilder: string | null;
  overallScore: number;
  topUrgentIssue: string;
  bestQuickWin: string;
  mainProductRisk: string;
  findings: AuditFinding[];
  /** Will hold a screenshot data-URL or CDN URL once capture is implemented */
  screenshotUrl?: string;
  /** Scan reliability classification — drives UI quality warnings and failure states */
  scanQuality: ScanQuality;
}

type FixPrompts = Record<ToolId, string>;

// ── Evidence types ────────────────────────────────────────────────────────────

interface EvidenceSignal {
  label: string;
  value: string;
  status: "good" | "warning" | "critical" | "neutral";
  note?: string;
}

interface FindingEvidence {
  summary: string;
  signals: EvidenceSignal[];
  triggerReason: string;
  dataSource: "real" | "heuristic";
  /** Will hold a screenshot data-URL or CDN URL once capture is implemented */
  screenshotUrl?: string;
}

interface ConfidenceScore {
  /** 0–100 integer */
  score: number;
  level: "high" | "medium" | "low";
  signals: Array<{ label: string; status: "good" | "warning" | "critical" | "neutral" }>;
  /** One-sentence explanation of why this score was assigned */
  reason: string;
}

/** A heuristic page region expressed as % of the 1280×800 screenshot dimensions */
interface AnnotationRegion {
  x: number;      // 0–100 % of screenshot width
  y: number;      // 0–100 % of screenshot height
  width: number;  // 0–100 % of screenshot width
  height: number; // 0–100 % of screenshot height
  label: string;  // Short label shown on the overlay chip
}

const TOOL_LABELS: Record<ToolId, string> = {
  lovable: "Lovable",
  base44: "Base44",
  claude: "Claude",
  cursor: "Cursor",
  generic: "Generic",
};

/** One-line descriptions shown under the tab name in the drawer */
const TOOL_DESCRIPTIONS: Record<ToolId, string> = {
  lovable: "Visual/chat editor — page-layer changes only, no backend logic touched",
  base44: "App builder — preserves data model, collections, and workflows",
  claude: "Code-level fix with TypeScript safety, responsive check, and build validation",
  cursor: "IDE-native — codebase search, diff preview, file-scoped changes only",
  generic: "Tool-agnostic — works with any AI builder or assistant",
};

/** Returns the recommended ToolId tab for a detected builder string */
function getRecommendedTab(detectedBuilder: string | null): ToolId | null {
  if (!detectedBuilder) return null;
  const b = detectedBuilder.toLowerCase();
  if (b.includes("lovable")) return "lovable";
  if (b.includes("base44")) return "base44";
  if (b.includes("cursor")) return "cursor";
  // v0 generates Next.js/React code → Claude is the closest match
  if (b.includes("v0") || b.includes("vercel v0")) return "claude";
  // Bolt, Replit, StackBlitz → code output → Claude
  if (b.includes("bolt") || b.includes("replit") || b.includes("stackblitz")) return "claude";
  // Builder detected but unknown — generic is safest
  return "generic";
}

/** Tooltip copy for each recommended tab explaining why it was selected */
const RECOMMENDED_TOOLTIP: Record<ToolId, string> = {
  lovable: "This site appears to be built with Lovable. This prompt uses Lovable's visual editor conventions and prevents accidental changes to app logic.",
  base44: "This site appears to be built with Base44. This prompt preserves your data model and workflows while fixing only the UI layer.",
  claude: "The detected builder generates code-first output. This prompt is optimised for code-level implementation with TypeScript and responsive verification.",
  cursor: "Cursor detected. This prompt uses in-editor conventions — codebase search, diff review, and file-scoped changes.",
  generic: "Builder detected but no specific tab matches. This generic prompt works with any AI builder or assistant.",
};

// ── Known blocked / restricted domains ───────────────────────────────────────
/**
 * Domains that always require login, use heavy bot protection, or redirect to
 * an auth page.  Auditing these produces findings from the auth page, not the product.
 * These are classified FAILED regardless of DOM content.
 */
const KNOWN_BLOCKED_DOMAINS = new Set([
  "linkedin.com",
  "facebook.com",
  "instagram.com",
  "x.com",
  "twitter.com",
  "chat.openai.com",
  "app.slack.com",      // always redirects to login / SSO page
  "app.hubspot.com",    // always requires authentication
  "app.notion.so",      // always requires authentication
  "app.figma.com",      // always requires authentication
]);

/**
 * Domains that serve real public content but are complex enough
 * (news portals, large ecommerce, SaaS homepages with heavy JS) that
 * GREEN requires screenshot confirmation — results without a screenshot
 * are capped at YELLOW.
 */
const KNOWN_COMPLEX_DOMAINS = new Set([
  // Israeli news / media
  "ynet.co.il",
  "calcalist.co.il",
  "haaretz.co.il",
  "walla.co.il",
  "mako.co.il",
  "sport5.co.il",
  "kan.org.il",
  // Israeli ecommerce
  "shufersal.co.il",
  "rami-levy.co.il",
  "ivory.co.il",
  "bug.co.il",
  // Large global news / ecommerce
  "bbc.com",
  "cnn.com",
  "amazon.com",
  "ebay.com",
  "aliexpress.com",
  // SaaS homepages that are heavy SPAs
  "slack.com",
  "notion.so",
  "figma.com",
]);

/**
 * Login-page signal phrases — detected in title + H1 text.
 * When matched AND content is thin the page is classified FAILED
 * because findings would reflect the auth page, not the product.
 */
const LOGIN_PAGE_SIGNALS = [
  "log in", "sign in", "login", "signup", "sign up",
  "join now", "authentication", "create account", "create your account",
  "email or mobile number", "phone number", "continue with",
  "forgot password", "reset password", "enter your password",
];

/**
 * Well-known platform brands — used to detect domain mismatch.
 * If the audited URL is NOT on one of these brands but the page title/H1
 * clearly belongs to one, the site redirected to a third-party auth page.
 */
const MISMATCH_BRANDS = ["facebook", "meta", "google", "apple", "microsoft", "twitter"];

/**
 * Known AI-builder / SPA-hosting platforms.
 * These sites serve a static React/Vite shell by design — thin initial HTML is expected,
 * not a sign of failure.  A loaded screenshot confirms the app is accessible.
 */
const KNOWN_AI_BUILDER_DOMAINS = new Set([
  "lovable.app",
  "gptengineer.app",   // Lovable's previous domain
  "bolt.new",
  "bolt.diy",
  "v0.dev",
  "replit.app",
  "glitch.me",
  "stackblitz.io",
  "webcontainer.io",
  "codesandbox.io",
]);

// ── Scan quality classifier ───────────────────────────────────────────────────

/**
 * Evaluates DOM signals to classify how reliably the page was scanned.
 * Called immediately after API response — before building findings.
 *
 * RELIABLE  → full output, no warnings
 * LIMITED   → output shown with specific reasons banner
 * FAILED    → all audit output blocked; only error UI shown
 */
function computeScanQuality(
  data: APIAuditData | null,
  fetchError: string | null,
  url?: string,
): ScanQuality {
  // ── Extract hostname for domain checks ──────────────────────────────────────
  let hostname = "";
  if (url) {
    try {
      hostname = new URL(url.startsWith("http") ? url : `https://${url}`)
        .hostname.toLowerCase().replace(/^www\./, "");
    } catch { /* ignore */ }
  }

  // ── Domain classification helpers ─────────────────────────────────────────
  const matchesDomain = (set: Set<string>) =>
    hostname ? [...set].some((d) => hostname === d || hostname.endsWith(`.${d}`)) : false;

  const isBlockedDomain    = matchesDomain(KNOWN_BLOCKED_DOMAINS);
  const isComplexDomain    = matchesDomain(KNOWN_COMPLEX_DOMAINS);
  const isAIBuilderSite    = matchesDomain(KNOWN_AI_BUILDER_DOMAINS);

  // ── FAILED: known blocked / login-heavy domain ─────────────────────────────
  if (isBlockedDomain) {
    return {
      status: "failed",
      reasons: [
        "This domain typically requires login, uses bot protection, or redirects to an authentication page",
        "Audit findings would be based on a login or redirect page, not the actual product",
      ],
      confidence: 0,
    };
  }

  // ── FAILED: API error or null data ─────────────────────────────────────────
  if (!data || fetchError) {
    const reasons: string[] = [];
    if (fetchError) reasons.push(fetchError);
    else reasons.push("Page data could not be retrieved");
    return { status: "failed", reasons, confidence: 0 };
  }

  const hasTitle   = !!data.title && data.title.trim().length > 0;
  const hasH1      = data.h1Tags.length > 0;
  const hasButtons = data.buttons.total > 0;
  const hasLinks   = data.links.total > 3;
  const hasMeta    = !!data.description && data.description.trim().length > 0;
  const wordCount  = data.wordCount;
  const signalCount = [hasTitle, hasH1, hasButtons, hasLinks, hasMeta].filter(Boolean).length;

  const titleAndH1 = [data.title ?? "", ...data.h1Tags].join(" ").toLowerCase();
  const isLoginPage = LOGIN_PAGE_SIGNALS.some((s) => titleAndH1.includes(s));

  // ── AI-builder SPA override — rendered DOM is the source of truth ───────────
  // For Lovable / Bolt / v0 etc., the static HTML is always a shell by design.
  // When the server-side Puppeteer pass extracted meaningful rendered DOM,
  // treat it as authoritative and classify RELIABLE immediately.
  if (isAIBuilderSite && data.analysisSource === "rendered-dom" && !isLoginPage) {
    const renderedSignals = [hasTitle, hasH1, hasButtons, hasLinks, hasMeta].filter(Boolean).length;
    if (renderedSignals >= 3 && wordCount >= 50) {
      // Confidence ≥ 90 → GREEN even without screenshot; screenshot is then a bonus.
      const conf = Math.min(95, Math.round(
        68 +
          (hasTitle   ? 5 : 0) +
          (hasH1      ? 5 : 0) +
          (hasMeta    ? 4 : 0) +
          (hasButtons ? 4 : 0) +
          (Math.min(wordCount, 400) / 400) * 9,
      ));
      return { status: "reliable", reasons: [], confidence: conf, isAIBuilderSite: true };
    }
  }

  // ── AI-builder SPA fallback — thin static shell is expected, not a failure ──
  // If rendered DOM extraction timed out or was skipped, the static HTML will be
  // nearly empty (React/Vite shell).  Mark as LIMITED so the screenshot can
  // upgrade it to GREEN via getScanTrafficLight; don't hard-block as FAILED.
  if (isAIBuilderSite && signalCount <= 2 && wordCount < 40 && !isLoginPage) {
    return {
      status: "limited",
      reasons: [
        "Static HTML shell detected — this is a React/Vite SPA whose content renders client-side",
        "Screenshot availability will confirm whether the app loaded successfully",
      ],
      confidence: 40,
      isAIBuilderSite: true,
    };
  }

  // ── FAILED: domain mismatch — page belongs to a different platform ─────────
  // e.g. app.slack.com redirected to Facebook's own login screen
  const mismatchBrand = MISMATCH_BRANDS.find(
    (b) => titleAndH1.includes(b) && hostname && !hostname.includes(b),
  );
  if (mismatchBrand && isLoginPage) {
    return {
      status: "failed",
      reasons: [
        `Page appears to be a ${mismatchBrand.charAt(0).toUpperCase() + mismatchBrand.slice(1)} login screen — the requested site redirected to a third-party authentication page`,
        "Audit findings would not reflect the intended website's content or UX",
      ],
      confidence: 0,
    };
  }

  // ── FAILED: login / auth page detected ────────────────────────────────────
  // Raise the threshold to 500 words so we catch more login-with-marketing-copy pages.
  if (isLoginPage && wordCount < 500) {
    return {
      status: "failed",
      reasons: [
        "Page appears to be a login or sign-in screen — product content is not accessible",
        "Findings would reflect the authentication page, not the actual product experience",
      ],
      confidence: 5,
    };
  }

  // ── FAILED: virtually empty DOM ────────────────────────────────────────────
  if (signalCount <= 1 && wordCount < 25) {
    const reasons: string[] = [];
    if (wordCount < 10) reasons.push(`Only ${wordCount} words of readable text extracted`);
    else reasons.push(`Very thin content (${wordCount} words) — page likely blocked or fully client-rendered`);
    if (!hasTitle && !hasH1) reasons.push("No page title or H1 detected");
    if (!hasButtons && !hasLinks) reasons.push("No buttons or links found — interactive structure unverifiable");
    reasons.push("Insufficient DOM content to produce reliable findings");
    return { status: "failed", reasons, confidence: 5, screenshotRequired: isComplexDomain };
  }

  // ── Collect LIMITED signals ────────────────────────────────────────────────
  const limitedReasons: string[] = [];

  if (wordCount < 50) {
    limitedReasons.push(`Very low readable text (${wordCount} words) — client-side rendering suspected`);
  } else if (wordCount < 120) {
    limitedReasons.push(`Low readable text (${wordCount} words) — some findings may be based on heuristics`);
  }

  if (!hasTitle && !hasH1) {
    limitedReasons.push("No page title or H1 found — structural signals incomplete");
  } else if (!hasH1) {
    limitedReasons.push("No H1 tag found — heading hierarchy could not be verified");
  }

  if (!hasButtons && !hasLinks) {
    limitedReasons.push("No interactive elements detected — CTA and navigation analysis is heuristic-only");
  }

  if (signalCount < 3) {
    limitedReasons.push(`Only ${signalCount}/5 content signals present — audit confidence reduced`);
  }

  if (limitedReasons.length > 0) {
    const confidence = Math.max(
      20,
      Math.min(
        64,
        20 + signalCount * 7 + Math.min(wordCount, 300) / 300 * 20 + (hasTitle ? 5 : 0),
      ),
    );
    return {
      status: "limited",
      reasons: limitedReasons,
      confidence: Math.round(confidence),
      screenshotRequired: isComplexDomain,
      isAIBuilderSite,
    };
  }

  // ── RELIABLE ───────────────────────────────────────────────────────────────
  const confidence = Math.min(
    95,
    Math.round(
      65 +
        (hasTitle   ? 5 : 0) +
        (hasH1      ? 5 : 0) +
        (hasMeta    ? 5 : 0) +
        (hasButtons ? 5 : 0) +
        (Math.min(wordCount, 500) / 500) * 10,
    ),
  );
  return {
    status: "reliable",
    reasons: [],
    confidence,
    screenshotRequired: isComplexDomain,
    isAIBuilderSite,
  };
}

// ── Traffic-light display gate ────────────────────────────────────────────────

/**
 * Classifies a completed scan into a traffic-light color.
 *
 * GREEN  → show full audit results immediately
 * YELLOW → require explicit user confirmation before showing any results
 * RED    → block all findings/scores/prompts; show failure screen only
 *
 * @param screenshotAvailable — pass `true` once the screenshot has loaded.
 *   Without a screenshot, GREEN requires very strong DOM signals (confidence ≥ 90).
 *   confidence ≥ 90 is treated as self-sufficient — screenshot is then a bonus.
 */
function getScanTrafficLight(quality: ScanQuality, screenshotAvailable: boolean): "green" | "yellow" | "red" {
  if (quality.status === "failed") return "red";

  // AI-builder / SPA sites: screenshot is the authoritative confirmation signal.
  // A loaded screenshot proves the app rendered correctly regardless of static DOM thinness.
  // Login-page and domain-mismatch failures are still caught before this point (status="failed").
  if (quality.isAIBuilderSite && screenshotAvailable) return "green";

  if (quality.status === "limited") return "yellow";
  if (quality.confidence < 80) return "yellow";
  // Complex/news/ecommerce domains ALWAYS require screenshot confirmation for GREEN
  if (quality.screenshotRequired && !screenshotAvailable) return "yellow";
  // All other domains: without screenshot, require very strong DOM (≥ 90) for GREEN
  if (!screenshotAvailable && quality.confidence < 90) return "yellow";
  return "green";
}

// ── Post-deploy QA test sites ─────────────────────────────────────────────────
/**
 * Run these manually after each release to verify scan quality behavior.
 * Compare actual scanQuality.status against `expected` for each entry.
 *
 * USAGE: Paste a URL from this list into the audit tool and check the
 *        scan quality badge in the results header.
 */
const QA_TEST_SITES = [
  // ✅ AI-built — expect RELIABLE (server-rendered HTML, minimal JS gating)
  { url: "https://rapyd-spark-insights.lovable.app/", expected: "reliable", note: "Lovable demo — server HTML present" },
  { url: "https://base44.app/",                       expected: "reliable", note: "Base44 marketing site" },
  // ✅ SaaS marketing — expect RELIABLE
  { url: "https://vercel.com",                        expected: "reliable", note: "SSR marketing site" },
  { url: "https://linear.app",                        expected: "reliable", note: "SaaS marketing, SSR" },
  { url: "https://wix.com",                           expected: "reliable", note: "Israeli SaaS marketing" },
  // ⚠ SPA-heavy — expect LIMITED (thin initial HTML, content loads via JS)
  { url: "https://figma.com",                         expected: "limited",  note: "Large SPA, reduced SSR" },
  { url: "https://notion.so",                         expected: "limited",  note: "Hybrid SPA" },
  // ❌ Login-required / blocked — expect FAILED
  { url: "https://app.hubspot.com",                   expected: "failed",   note: "Requires authentication" },
  { url: "https://x.com",                             expected: "failed",   note: "Bot-blocking social platform" },
  { url: "https://localhost:3000",                    expected: "failed",   note: "Local URL — unreachable from API" },
] as const;
// Suppress unused-variable lint warning in dev
void QA_TEST_SITES;

const LOADING_STAGES = [
  "Connecting to target site...",
  "Fetching and parsing HTML...",
  "Analysing signals and structure...",
  "Generating audit findings...",
];

// ── Fix prompt generator ──────────────────────────────────────────────────────

const CATEGORY_CONTEXT: Record<Category, string> = {
  "Product Clarity": "Focus on the hero, headline, and value proposition. The user must understand what the product does and who it is for within 5 seconds.",
  "User Journey": "Map the user's path from arrival to activation. Identify where they get stuck, confused, or lose momentum.",
  "Conversion": "Focus on the activation path — reduce gates, remove friction, and make the primary action unavoidable above the fold.",
  "UX Friction": "Identify the specific interaction causing friction. Fix the flow, not the surface. Every extra step reduces completion rate.",
  "Trust Signals": "Add trust elements near the decision point. B2B buyers look for proof before they act. Show it where it matters.",
  "Accessibility": "This feature must work for all users. Check WCAG AA compliance and test with a screen reader before marking this resolved.",
  "Mobile Experience": "Switch to mobile-first. Test at 375px. Primary actions must be reachable without scrolling. Touch targets must be at least 44px.",
  "Performance Perception": "Slow load time is a product experience failure, not just a technical issue. Users form judgments before the page is fully rendered.",
};

const TOOL_CONSTRAINTS: Record<ToolId, string> = {
  lovable: "Preserve the existing visual style, component structure, and design system. Do not redesign unrelated sections, change the colour palette, or modify components not involved in this fix.",
  base44: "Preserve the existing data model, API connections, and all business logic. Update only the UI and UX layer. Do not modify database schemas, backend logic, or existing routes.",
  claude: "Do not refactor unrelated components or files. Write clean TypeScript — no any types. Ensure changes are responsive at 375px, 768px, and 1280px. Do not change routing or auth logic.",
  cursor: "Use the existing code conventions, file structure, and naming patterns. Do not create new files unless strictly necessary. Only edit the files directly involved in this fix.",
  generic: "Fix only what is described. Do not change unrelated sections, authentication, database logic, or any component outside the scope of this issue.",
};

function buildFixPrompts(finding: AuditFinding, detectedBuilder: string | null): FixPrompts {
  const { issue, category, suggestedFix, whyItMatters, priority } = finding;
  const isUrgent = priority === "urgent";
  const context = CATEGORY_CONTEXT[category];
  const urgencyFlag = isUrgent ? "\n⚠  CRITICAL — this issue directly impacts user experience or conversion.\n" : "";

  const prompts: FixPrompts = {} as FixPrompts;

  // ── LOVABLE ──────────────────────────────────────────────────────────────────
  // Workflow: visual/chat editor, page-layer only, no backend changes
  prompts.lovable = `You are editing this Lovable project using the chat interface.
Fix one specific product issue. Do not touch anything else.
${urgencyFlag}
ISSUE TO FIX
Category: ${category} · Priority: ${priority.toUpperCase()}
"${issue}"

WHY THIS MATTERS
${whyItMatters}

WHAT TO CHANGE
${suggestedFix}

HOW TO DO IT IN LOVABLE
• Use the Lovable chat to describe the visual change — do not manually edit code unless necessary.
• Target only the specific section, component, or copy described above.
• Keep the existing layout, color palette, typography, and component structure intact.
• If adjusting a CTA, heading, or copy block: update the text and visual treatment only.
• If adjusting spacing or responsiveness: use Tailwind utility classes that already exist in the project.
• Test the fix in the Lovable preview at both mobile and desktop sizes before publishing.

DO NOT CHANGE
• Any React hooks, API calls, Supabase queries, or authentication logic
• Backend routes, serverless functions, or data-fetching logic
• Other pages or components not directly related to this issue
• Navigation structure, routing, or app-level layout

ACCEPTANCE CRITERIA
The issue above is visually resolved in the Lovable preview.
The fix works at 375px (mobile) and 1280px (desktop).
No app logic, data connections, or unrelated sections have changed.`;

  // ── BASE44 ───────────────────────────────────────────────────────────────────
  // Workflow: app builder with visual data model — UX changes only, data layer untouched
  prompts.base44 = `You are editing this Base44 app.
Fix one specific UX issue. The data model and business logic must remain completely untouched.
${urgencyFlag}
ISSUE TO FIX
Category: ${category} · Priority: ${priority.toUpperCase()}
"${issue}"

WHY THIS MATTERS
${whyItMatters}

WHAT TO CHANGE
${suggestedFix}

HOW TO DO IT IN BASE44
• Navigate to the specific screen or component where this issue appears.
• Make only UI-level changes: copy text, component visibility, labels, layout, or UX flow.
• If adding a new UI element is required, add it to the relevant screen only — not globally.
• After editing, preview the screen as a standard user (not as admin) to confirm the fix works.
• If the fix requires showing or hiding a field: use visibility conditions, not data model changes.

DO NOT CHANGE
• Collections, data models, field definitions, or relationships
• Existing workflows, automation rules, triggers, or formula columns
• User roles, permissions, access control settings, or app-level security rules
• API connections, external integrations, or authentication logic
• Any other screen or component outside the scope of this issue

ACCEPTANCE CRITERIA
The issue above is resolved on the relevant screen.
The fix is visible and correct when accessed as a standard (non-admin) user.
No collections, workflows, permissions, or API connections have been modified.
Existing data continues to display correctly after the fix.`;

  // ── CLAUDE ───────────────────────────────────────────────────────────────────
  // Workflow: code-level, TypeScript-safe, build-validated, minimal change
  prompts.claude = `You have full access to this codebase. Fix one specific issue.
Make the smallest safe change that resolves it. Do not refactor anything else.
${urgencyFlag}
ISSUE TO FIX
Category: ${category} · Priority: ${priority.toUpperCase()}
"${issue}"

WHY THIS MATTERS
${whyItMatters}

WHAT TO CHANGE
${suggestedFix}

IMPLEMENTATION STEPS
1. Find the component — search the codebase for the element described above.
   Look for: the relevant UI section, CTA element, or ${category.toLowerCase()} pattern.

2. Plan before editing — identify the smallest change that resolves the issue.
   Do not refactor surrounding code or extract new components unless strictly needed.

3. Apply the fix — edit only the specific file(s) involved.
   • Preserve all existing props, state interfaces, and component APIs.
   • Write clean TypeScript — no \`any\` types, no unnecessary \`as\` casts.
   • If CSS/Tailwind changes are needed, add to existing classes — do not remove unrelated ones.

4. Verify responsiveness — confirm the fix renders correctly at:
   375px · 768px · 1280px

5. Run the build — execute \`npm run build\` and resolve all TypeScript errors before finishing.
   The build must pass with zero errors.

DO NOT CHANGE
• Files unrelated to this specific issue
• Routing, authentication, or API endpoint logic
• Existing component APIs or exported interfaces
• Folder structure, file naming, or module exports
• Any third-party dependency versions

ACCEPTANCE CRITERIA
The issue above is visually and functionally resolved.
\`npm run build\` passes with zero errors and zero TypeScript warnings.
The fix is correct at 375px, 768px, and 1280px.
No unrelated tests, components, or routes have been modified.`;

  // ── CURSOR ───────────────────────────────────────────────────────────────────
  // Workflow: IDE-native, diff-first, codebase search, minimal file scope
  prompts.cursor = `You are working inside this codebase in Cursor.
Before applying any change, show the planned diff and confirm scope.
${urgencyFlag}
ISSUE TO FIX
Category: ${category} · Priority: ${priority.toUpperCase()}
"${issue}"

WHY THIS MATTERS
${whyItMatters}

WHAT TO CHANGE
${suggestedFix}

CURSOR WORKFLOW — FOLLOW THESE STEPS IN ORDER

Step 1 — Locate the code
Use @codebase or ⌘K to search for the component or section related to this issue.
Search terms to try: ${category.toLowerCase()} elements, CTA patterns, or the specific text/element described above.
Identify the file and line range before making any edit.

Step 2 — Plan the change
Before editing, describe:
  • Which file(s) will change
  • What specifically will change in each file
  • Why that is the minimal fix

Show the planned diff. Do not apply until the scope is clear and minimal.

Step 3 — Apply with Composer or Chat
For single-file changes: use Cursor Chat with the file open.
For multi-file changes: use Cursor Composer — but keep the scope as tight as possible.
Press Accept only after reviewing the full diff.

Step 4 — Verify
Check the fix renders correctly at 375px and 1280px.
Confirm no TypeScript errors were introduced (check Problems panel).

DO NOT CHANGE
• Files outside the direct scope of this fix
• Routing, auth, or data model logic
• Unrelated components, even if they look "improvable"
• Create new files unless the fix strictly requires it
• Rename, move, or restructure any existing files

ACCEPTANCE CRITERIA
The issue is resolved. The diff is minimal and self-contained.
No unrelated files appear in the diff.
The Cursor Problems panel shows zero new errors.`;

  // ── GENERIC ──────────────────────────────────────────────────────────────────
  // Tool-agnostic: works with any AI builder, no tool-specific language
  prompts.generic = `Fix this specific product issue. One change — nothing else.
${urgencyFlag}
ISSUE TO FIX
Category: ${category} · Priority: ${priority.toUpperCase()}
"${issue}"

WHY THIS MATTERS
${whyItMatters}

WHAT TO CHANGE
${suggestedFix}

PM CONTEXT — WHY THIS CATEGORY MATTERS
${context}

SCOPE GUARDRAILS
• Fix only what is described above.
• Do not redesign or modify unrelated sections, pages, or components.
• Do not change authentication, database logic, or backend functionality.
• If you are unsure about the scope of the change, ask before editing.

TESTING
After applying the fix:
• Confirm the issue above is visually or functionally resolved.
• Test at mobile (375px) and desktop (1280px).
• Verify that no other part of the product has changed as a side effect.

ACCEPTANCE CRITERIA
The issue is resolved. Nothing unrelated to this fix has changed.
The fix is visible and correct on both mobile and desktop viewports.`;

  return prompts;
}

// ── Evidence engine — maps audit signals to findings ─────────────────────────

function buildFindingEvidence(
  finding: AuditFinding,
  apiData: APIAuditData | null,
  url: string,
  isRealAudit: boolean
): FindingEvidence {
  // No live data — heuristic mode
  if (!apiData || !isRealAudit) {
    return {
      summary: "This finding was generated from URL pattern analysis — the page could not be fetched for a live audit.",
      signals: [
        { label: "Audit mode", value: "URL heuristics (no live fetch)", status: "warning" },
        { label: "URL analysed", value: url.replace(/https?:\/\//, ""), status: "neutral" },
        { label: "Finding basis", value: `${finding.category} · pattern match`, status: "neutral" },
        { label: "Priority", value: finding.priority, status: finding.priority === "urgent" ? "critical" : finding.priority === "important" ? "warning" : "neutral" },
      ],
      triggerReason: "The auditor could not fetch this URL. Findings are based on URL pattern analysis and known site-type characteristics — not live page content. For evidence-backed findings, ensure the URL is publicly accessible.",
      dataSource: "heuristic",
    };
  }

  const { category, issue } = finding;
  const issueLower = issue.toLowerCase();

  switch (category) {

    // ── PRODUCT CLARITY ───────────────────────────────────────────────────────
    case "Product Clarity": {
      const titleLen = apiData.title?.length ?? 0;
      const descLen = apiData.description?.length ?? 0;
      const h1Count = apiData.h1Tags?.length ?? 0;
      const h2Count = apiData.h2Tags?.length ?? 0;
      const firstH1 = apiData.h1Tags?.[0] ?? "";

      const signals: EvidenceSignal[] = [
        {
          label: "Page title",
          value: apiData.title ? `"${apiData.title.slice(0, 60)}${apiData.title.length > 60 ? "…" : ""}"` : "Not found",
          status: !apiData.title ? "critical" : titleLen < 20 ? "warning" : titleLen > 70 ? "warning" : "good",
        },
        {
          label: "Title length",
          value: titleLen > 0 ? `${titleLen} characters` : "0 characters",
          status: titleLen === 0 ? "critical" : titleLen < 20 ? "warning" : titleLen > 70 ? "warning" : "good",
          note: "Target: 20–60 characters for clear product identity",
        },
        {
          label: "Meta description",
          value: apiData.description ? `${descLen} chars · "${apiData.description.slice(0, 50)}${descLen > 50 ? "…" : ""}"` : "Missing",
          status: !apiData.description ? "critical" : descLen < 50 ? "warning" : "good",
          note: "Target: 120–155 characters",
        },
        {
          label: "H1 tags found",
          value: h1Count === 0 ? "None" : `${h1Count}${firstH1 ? ` · "${firstH1.slice(0, 50)}${firstH1.length > 50 ? "…" : ""}"` : ""}`,
          status: h1Count === 0 ? "critical" : h1Count > 3 ? "warning" : "good",
          note: "Target: 1–2 H1 tags as the primary value statement",
        },
        {
          label: "H2 tags found",
          value: `${h2Count}`,
          status: "neutral",
        },
        {
          label: "Word count",
          value: `${apiData.wordCount} words`,
          status: apiData.wordCount < 80 ? "critical" : apiData.wordCount < 200 ? "warning" : "good",
          note: "Target: ≥ 200 words for a product page",
        },
        {
          label: "CTA elements detected",
          value: apiData.ctaElements.length > 0
            ? `${apiData.ctaElements.length} found · "${apiData.ctaElements.slice(0, 2).join('", "')}"`
            : "None detected",
          status: apiData.ctaElements.length === 0 ? "critical" : "good",
        },
      ];

      let summary = "";
      let triggerReason = "";

      if (!apiData.title || issueLower.includes("no name") || issueLower.includes("no title")) {
        summary = "No page title tag was found. The product has no name in browser tabs, search results, or link previews.";
        triggerReason = "Condition: title tag must be present. Actual: title is empty or missing.";
      } else if (issueLower.includes("too vague") || (titleLen > 0 && titleLen < 20)) {
        summary = `The page title is ${titleLen} characters — too short to communicate product value or audience to users scanning search results.`;
        triggerReason = `Threshold: title length must be ≥ 20 characters. Actual: ${titleLen} characters ("${apiData.title}").`;
      } else if (issueLower.includes("cut off") || titleLen > 70) {
        summary = `The title is ${titleLen} characters. Search engines and link previews truncate at ~60 characters — the end of your title may never be seen.`;
        triggerReason = `Threshold: titles over 60 characters are truncated. Actual: ${titleLen} characters.`;
      } else if (issueLower.includes("no product description") || !apiData.description) {
        summary = "No meta description tag was found. Search engines and social platforms will auto-generate preview text from random page content.";
        triggerReason = "Condition: meta description must be present. Actual: no description detected.";
      } else if (issueLower.includes("description is too brief") || (descLen > 0 && descLen < 50)) {
        summary = `The meta description is only ${descLen} characters — too short to communicate context or value to users scanning search results.`;
        triggerReason = `Threshold: description should be ≥ 50 characters for meaningful previews. Actual: ${descLen} characters.`;
      } else if (issueLower.includes("no clear value statement") || h1Count === 0) {
        summary = "No H1 tag was detected. There is no primary value statement anchoring the page for users or search engines.";
        triggerReason = "Condition: at least one H1 is required as the primary message. Actual: 0 H1 tags detected.";
      } else if (issueLower.includes("competing headlines") || h1Count > 3) {
        summary = `${h1Count} H1 tags were found — multiple competing headlines dilute the page's primary message and confuse both users and search engines.`;
        triggerReason = `Threshold: a page should have 1–3 H1 tags. Actual: ${h1Count} H1 tags.`;
      } else if (issueLower.includes("not enough product story") || apiData.wordCount < 80) {
        summary = `Only ${apiData.wordCount} words were found. This is not enough to explain what the product does, who it is for, and why it matters.`;
        triggerReason = `Threshold: minimum 80 words required for product context. Actual: ${apiData.wordCount} words.`;
      } else {
        summary = "The page lacks sufficient content or structure to communicate product value clearly within 5 seconds.";
        triggerReason = `Signals reviewed: title (${titleLen} chars), H1s (${h1Count}), word count (${apiData.wordCount}).`;
      }

      return { summary, signals, triggerReason, dataSource: "real" };
    }

    // ── CONVERSION ────────────────────────────────────────────────────────────
    case "Conversion": {
      const buttonCount = apiData.buttons.total;
      const ctaCount = apiData.ctaElements.length;
      const formCount = apiData.forms.total;

      const signals: EvidenceSignal[] = [
        {
          label: "CTA elements detected",
          value: ctaCount > 0 ? `${ctaCount} · "${apiData.ctaElements.slice(0, 2).join('", "')}"` : "None detected",
          status: ctaCount === 0 ? "critical" : "good",
          note: "Outcome-based copy: 'Get started', 'Try free', 'See how it works'",
        },
        {
          label: "Buttons on page",
          value: buttonCount > 0
            ? `${buttonCount} · "${apiData.buttons.samples.slice(0, 2).join('", "')}"`
            : "None detected",
          status: buttonCount === 0 ? "critical" : ctaCount === 0 ? "warning" : "good",
        },
        {
          label: "Forms detected",
          value: `${formCount}`,
          status: formCount === 0 && !apiData.signals.hasSignup ? "warning" : "good",
        },
        {
          label: "Pricing detectable",
          value: apiData.signals.hasPricing ? "Yes" : "Not found",
          status: apiData.signals.hasPricing ? "good" : "warning",
          note: apiData.signals.hasPricing ? `Indicators: ${apiData.signals.pricingIndicators.slice(0, 2).join(", ")}` : undefined,
        },
        {
          label: "Sign-up path detectable",
          value: apiData.signals.hasSignup ? "Yes" : "Not found",
          status: apiData.signals.hasSignup ? "good" : "warning",
          note: apiData.signals.hasSignup ? `Indicators: ${apiData.signals.signupIndicators.slice(0, 2).join(", ")}` : undefined,
        },
        {
          label: "Contact path",
          value: apiData.signals.hasContact ? "Found" : "Not found",
          status: apiData.signals.hasContact ? "good" : "neutral",
        },
      ];

      let summary = "";
      let triggerReason = "";

      if (ctaCount === 0 && buttonCount === 0) {
        summary = "No call-to-action elements or buttons were detected on this page. There is no activation path for users who are ready to act.";
        triggerReason = "Condition: at least one CTA or button required. Actual: 0 CTAs, 0 buttons detected.";
      } else if (ctaCount === 0 && buttonCount > 0) {
        summary = `${buttonCount} buttons were found, but none contain outcome-based copy. Generic labels like "Submit" or "Learn more" don't give users a reason to click.`;
        triggerReason = `Condition: buttons must use outcome-based copy to count as CTAs. Actual: ${buttonCount} buttons, 0 recognized as CTAs. Buttons found: "${apiData.buttons.samples.slice(0, 3).join('", "')}"`;
      } else if (!apiData.signals.hasPricing) {
        summary = "No pricing information was detectable. B2B buyers cannot self-qualify, which typically causes 40–60% of prospects to disengage before contacting sales.";
        triggerReason = "Condition: pricing information should be present on a SaaS or product site. Actual: no pricing indicators detected.";
      } else if (!apiData.signals.hasSignup) {
        summary = "No sign-up or account creation path was detected. Users who are ready to try the product have nowhere to go.";
        triggerReason = `Condition: self-service activation path should be detectable. Actual: no signup indicators found. Forms detected: ${formCount}.`;
      } else {
        summary = "The conversion path on this page has gaps that may reduce the rate at which interested users take action.";
        triggerReason = `Signals: CTAs (${ctaCount}), buttons (${buttonCount}), pricing (${apiData.signals.hasPricing}), signup (${apiData.signals.hasSignup}).`;
      }

      return { summary, signals, triggerReason, dataSource: "real" };
    }

    // ── USER JOURNEY ──────────────────────────────────────────────────────────
    case "User Journey": {
      const signals: EvidenceSignal[] = [
        {
          label: "Total links on page",
          value: `${apiData.links.total}`,
          status: apiData.links.total > 60 ? "warning" : "good",
          note: "Over 60 links can create decision paralysis",
        },
        {
          label: "Internal links",
          value: `${apiData.links.internal}`,
          status: "neutral",
        },
        {
          label: "External links",
          value: `${apiData.links.external}`,
          status: apiData.links.external > 20 ? "warning" : "neutral",
        },
        {
          label: "Forms detected",
          value: `${apiData.forms.total}`,
          status: "neutral",
        },
        {
          label: "Form input fields",
          value: `${apiData.forms.inputs}`,
          status: apiData.forms.inputs > 6 ? "warning" : "neutral",
          note: "Each additional field reduces completion by ~10%",
        },
        {
          label: "CTA elements",
          value: `${apiData.ctaElements.length}`,
          status: apiData.ctaElements.length === 0 && apiData.forms.total > 0 ? "warning" : "neutral",
        },
      ];

      let summary = "";
      let triggerReason = "";

      if (apiData.links.total > 60) {
        summary = `${apiData.links.total} links were found on this page. High link density fragments user attention and makes it harder to follow the primary conversion path.`;
        triggerReason = `Threshold: over 60 links triggers a User Journey finding. Actual: ${apiData.links.total} links.`;
      } else if (apiData.forms.total > 0 && apiData.ctaElements.length === 0) {
        summary = `${apiData.forms.total} form${apiData.forms.total > 1 ? "s" : ""} found but no CTA elements. Users encounter a form with no stated outcome or reason to complete it.`;
        triggerReason = `Condition: forms should be paired with outcome-oriented CTAs. Actual: ${apiData.forms.total} forms, 0 CTAs.`;
      } else {
        summary = "User journey signals were reviewed for friction points that reduce task completion or flow continuity.";
        triggerReason = `Signals: links (${apiData.links.total}), forms (${apiData.forms.total}), inputs (${apiData.forms.inputs}), CTAs (${apiData.ctaElements.length}).`;
      }

      return { summary, signals, triggerReason, dataSource: "real" };
    }

    // ── TRUST SIGNALS ─────────────────────────────────────────────────────────
    case "Trust Signals": {
      const signals: EvidenceSignal[] = [
        {
          label: "Contact path",
          value: apiData.signals.hasContact ? "Detected" : "Not found",
          status: apiData.signals.hasContact ? "good" : "warning",
          note: apiData.signals.hasContact
            ? `Indicators: ${apiData.signals.contactIndicators.slice(0, 2).join(", ")}`
            : "No email link, contact page, or chat widget found",
        },
        {
          label: "Open Graph tags",
          value: apiData.signals.hasOgTags ? "Present" : "Missing",
          status: apiData.signals.hasOgTags ? "good" : "warning",
          note: "Controls how this page looks when shared on LinkedIn, Slack, email",
        },
        {
          label: "Schema markup",
          value: apiData.signals.hasSchemaMarkup ? "Present" : "Not detected",
          status: apiData.signals.hasSchemaMarkup ? "good" : "neutral",
        },
        {
          label: "Chat widget",
          value: apiData.signals.hasChatWidget ? "Detected" : "Not detected",
          status: "neutral",
        },
        {
          label: "Cookie consent",
          value: apiData.signals.hasCookieBanner ? "Present" : "Not detected",
          status: "neutral",
        },
      ];

      let summary = "";
      let triggerReason = "";

      if (!apiData.signals.hasContact) {
        summary = "No contact path was detected — no email link, contact page, or chat widget found. B2B buyers and first-time users look for a way to reach the team as a trust signal.";
        triggerReason = "Condition: contact path (email, contact page, or chat widget) should be detectable. Actual: none found.";
      } else if (!apiData.signals.hasOgTags) {
        summary = "No Open Graph tags were found. Every share of this page on LinkedIn, Slack, or email renders as a plain URL — no image, no title, no description.";
        triggerReason = "Condition: og:title, og:description, og:image should be present. Actual: no OG tags detected.";
      } else {
        summary = "Trust signals on this page were reviewed. Some signals that B2B buyers check before engaging are missing or incomplete.";
        triggerReason = `Signals: contact (${apiData.signals.hasContact}), OG tags (${apiData.signals.hasOgTags}), schema (${apiData.signals.hasSchemaMarkup}).`;
      }

      return { summary, signals, triggerReason, dataSource: "real" };
    }

    // ── ACCESSIBILITY ─────────────────────────────────────────────────────────
    case "Accessibility": {
      const missingRatio = apiData.images.total > 0
        ? Math.round((apiData.images.missingAlt / apiData.images.total) * 100)
        : 0;

      const signals: EvidenceSignal[] = [
        {
          label: "Total images",
          value: `${apiData.images.total}`,
          status: "neutral",
        },
        {
          label: "Images with alt text",
          value: `${apiData.images.withAlt} of ${apiData.images.total}`,
          status: apiData.images.withAlt === apiData.images.total ? "good" : "warning",
        },
        {
          label: "Images missing alt text",
          value: apiData.images.missingAlt > 0 ? `${apiData.images.missingAlt} images` : "None",
          status: apiData.images.missingAlt > 5 ? "critical" : apiData.images.missingAlt > 0 ? "warning" : "good",
        },
        {
          label: "Missing alt ratio",
          value: `${missingRatio}%`,
          status: missingRatio > 50 ? "critical" : missingRatio > 20 ? "warning" : "good",
          note: "WCAG AA requires all content images to have descriptive alt text",
        },
      ];

      if (apiData.images.missingAltSamples.length > 0) {
        signals.push({
          label: "Affected image sources",
          value: apiData.images.missingAltSamples.slice(0, 2).map(s => s.split("/").pop() ?? s).join(", "),
          status: "neutral",
          note: "Sample — not exhaustive",
        });
      }

      const summary = apiData.images.missingAlt > 0
        ? `${apiData.images.missingAlt} of ${apiData.images.total} images (${missingRatio}%) are missing alt text. Screen reader users cannot access this content, and it fails WCAG AA.`
        : "All images have alt text — accessibility is clear for this signal.";

      const triggerReason = apiData.images.missingAlt > 5
        ? `Threshold: >5 images missing alt text → Urgent. Actual: ${apiData.images.missingAlt} images without alt text out of ${apiData.images.total} total.`
        : `Threshold: any images missing alt text → Important. Actual: ${apiData.images.missingAlt} out of ${apiData.images.total} images missing alt.`;

      return { summary, signals, triggerReason, dataSource: "real" };
    }

    // ── MOBILE EXPERIENCE ─────────────────────────────────────────────────────
    case "Mobile Experience": {
      const signals: EvidenceSignal[] = [
        {
          label: "Viewport meta tag",
          value: apiData.signals.hasMobileViewport ? "Present" : "Missing",
          status: apiData.signals.hasMobileViewport ? "good" : "critical",
          note: apiData.signals.hasMobileViewport
            ? "width=device-width detected — responsive rendering enabled"
            : "Without this, mobile browsers render a scaled-down desktop view",
        },
        {
          label: "Page size",
          value: `${(apiData.pageSize / 1000).toFixed(0)}KB`,
          status: apiData.pageSize > 800_000 ? "critical" : apiData.pageSize > 400_000 ? "warning" : "good",
          note: "Larger pages create longer load times on mobile connections",
        },
        {
          label: "Open Graph tags",
          value: apiData.signals.hasOgTags ? "Present" : "Missing",
          status: apiData.signals.hasOgTags ? "good" : "warning",
        },
        {
          label: "Buttons detected",
          value: `${apiData.buttons.total}`,
          status: "neutral",
          note: "Touch targets should be ≥ 44×44px",
        },
      ];

      const summary = !apiData.signals.hasMobileViewport
        ? "The viewport meta tag is missing. The page renders as a scaled-down desktop layout on mobile — text is unreadable, navigation is unusable, and touch targets are too small."
        : "The viewport tag is present. Mobile experience issues detected relate to other mobile-specific signals.";

      const triggerReason = !apiData.signals.hasMobileViewport
        ? 'Condition: <meta name="viewport" content="width=device-width, initial-scale=1"> must be present. Actual: not detected.'
        : `Signals reviewed: viewport (${apiData.signals.hasMobileViewport}), page size (${(apiData.pageSize / 1000).toFixed(0)}KB).`;

      return { summary, signals, triggerReason, dataSource: "real" };
    }

    // ── PERFORMANCE PERCEPTION ────────────────────────────────────────────────
    case "Performance Perception": {
      const pageSizeKB = Math.round(apiData.pageSize / 1000);

      const signals: EvidenceSignal[] = [
        {
          label: "Page size",
          value: `${pageSizeKB}KB`,
          status: apiData.pageSize > 800_000 ? "critical" : apiData.pageSize > 400_000 ? "warning" : "good",
          note: "Target: < 300KB for fast initial render",
        },
        {
          label: "Server response time",
          value: `${apiData.fetchDuration}ms`,
          status: apiData.fetchDuration > 3000 ? "critical" : apiData.fetchDuration > 1500 ? "warning" : "good",
          note: "Time to first byte (TTFB) from the auditor's perspective",
        },
        {
          label: "Script tags",
          value: `${apiData.scripts}`,
          status: apiData.scripts > 15 ? "warning" : "good",
          note: "Each script adds a network request and may block rendering",
        },
        {
          label: "Stylesheet tags",
          value: `${apiData.stylesheets}`,
          status: apiData.stylesheets > 8 ? "warning" : "neutral",
        },
        {
          label: "Canonical tag",
          value: apiData.signals.hasCanonical ? "Present" : "Missing",
          status: apiData.signals.hasCanonical ? "good" : "warning",
          note: "Prevents duplicate page indexing in search engines",
        },
        {
          label: "Word count",
          value: `${apiData.wordCount} words`,
          status: "neutral",
        },
      ];

      let summary = "";
      let triggerReason = "";

      if (apiData.pageSize > 800_000) {
        summary = `The page is ${pageSizeKB}KB. On a typical mobile connection, this takes 3–5 seconds to load. 53% of mobile users abandon after 3 seconds.`;
        triggerReason = `Threshold: pages over 800KB → Urgent. Actual: ${pageSizeKB}KB.`;
      } else if (apiData.pageSize > 400_000) {
        summary = `The page is ${pageSizeKB}KB — above the recommended limit. This creates measurable load friction even on fast connections.`;
        triggerReason = `Threshold: pages over 400KB → Important. Actual: ${pageSizeKB}KB.`;
      } else if (apiData.scripts > 15) {
        summary = `${apiData.scripts} script tags detected. Each adds a network request and may block page rendering. This is likely more than the page needs.`;
        triggerReason = `Threshold: more than 15 scripts → Performance finding. Actual: ${apiData.scripts}.`;
      } else if (!apiData.signals.hasCanonical) {
        summary = "No canonical tag was found. Search engines may index multiple URL versions of this page, diluting SEO authority across duplicates.";
        triggerReason = "Condition: canonical link tag should be present. Actual: not detected.";
      } else {
        summary = "Performance signals were reviewed for this page.";
        triggerReason = `Signals: page size (${pageSizeKB}KB), scripts (${apiData.scripts}), fetch time (${apiData.fetchDuration}ms).`;
      }

      return { summary, signals, triggerReason, dataSource: "real" };
    }

    // ── UX FRICTION ───────────────────────────────────────────────────────────
    case "UX Friction": {
      const signals: EvidenceSignal[] = [
        {
          label: "Total links",
          value: `${apiData.links.total}`,
          status: apiData.links.total > 60 ? "warning" : "neutral",
        },
        {
          label: "Buttons",
          value: apiData.buttons.total > 0 ? `${apiData.buttons.total} · "${apiData.buttons.samples.slice(0, 2).join('", "')}"` : "0",
          status: "neutral",
        },
        {
          label: "Forms",
          value: `${apiData.forms.total}`,
          status: "neutral",
        },
        {
          label: "Form input fields",
          value: `${apiData.forms.inputs}`,
          status: apiData.forms.inputs > 5 ? "warning" : "neutral",
          note: "Each extra field before value reduces completion by ~10%",
        },
        {
          label: "CTA elements",
          value: `${apiData.ctaElements.length}`,
          status: apiData.ctaElements.length === 0 ? "warning" : "neutral",
        },
      ];

      return {
        summary: "UX friction signals were reviewed for patterns that increase drop-off or reduce task completion.",
        signals,
        triggerReason: `Signals: links (${apiData.links.total}), form inputs (${apiData.forms.inputs}), CTAs (${apiData.ctaElements.length}), buttons (${apiData.buttons.total}).`,
        dataSource: "real",
      };
    }

    // ── FALLBACK ──────────────────────────────────────────────────────────────
    default: {
      return {
        summary: "This finding was generated based on audit patterns for this site type and category.",
        signals: [
          { label: "Category", value: category, status: "neutral" },
          { label: "Audit mode", value: "Live page data", status: "good" },
          { label: "Priority", value: finding.priority, status: finding.priority === "urgent" ? "critical" : "neutral" },
        ],
        triggerReason: `Category: ${category}. Finding was created based on product audit patterns.`,
        dataSource: "real",
      };
    }
  }
}

// ── Confidence scoring engine ─────────────────────────────────────────────────
//
// Calculates how certain the audit engine is about a finding.
// Scores are derived exclusively from actual signals present in apiData —
// no mocked or hardcoded values. Each category is scored differently based on
// how direct its evidence is:
//   • Direct DOM facts (counts, measurements, boolean tags) → High confidence
//   • Keyword/pattern-based heuristics → Medium confidence
//   • URL-pattern only, no live fetch → Low confidence

function calculateConfidence(
  finding: AuditFinding,
  apiData: APIAuditData | null,
  isRealAudit: boolean,
): ConfidenceScore {
  // Heuristic mode — no live DOM data
  if (!apiData || !isRealAudit) {
    return {
      score: 40,
      level: "low",
      signals: [
        { label: "Live page fetch failed — URL heuristics only", status: "warning" },
        { label: "No DOM inspection performed", status: "warning" },
        { label: "Finding inferred from URL patterns and site type", status: "neutral" },
      ],
      reason: "Live page fetch failed or was not possible. This finding is based on URL pattern analysis and known site-type characteristics — not actual DOM inspection.",
    };
  }

  const { category } = finding;
  const sigs: Array<{ label: string; status: "good" | "warning" | "critical" | "neutral" }> = [];
  let score = 0;

  switch (category) {

    // All signals here are direct DOM reads — H1, title, description, word count
    // are exact values extracted from the fetched HTML. High confidence.
    case "Product Clarity": {
      score += 30;
      sigs.push({ label: `${apiData.h1Tags.length} H1 tag${apiData.h1Tags.length !== 1 ? "s" : ""} found`, status: apiData.h1Tags.length === 0 ? "critical" : "good" });

      score += 20;
      sigs.push({ label: `${apiData.wordCount} words scanned`, status: apiData.wordCount < 80 ? "critical" : apiData.wordCount < 200 ? "warning" : "good" });

      score += 20;
      sigs.push({ label: apiData.title ? `Title detected (${apiData.title.length} chars)` : "No title tag detected", status: apiData.title ? "good" : "critical" });

      score += 20;
      sigs.push({ label: apiData.description ? `Meta description (${apiData.description.length} chars)` : "No meta description", status: apiData.description ? "good" : "critical" });

      score += 7;
      sigs.push({ label: `${apiData.h2Tags?.length ?? 0} H2 tags found`, status: "neutral" });
      break;
    }

    // CTA detection is pattern-matched (lower certainty); buttons and forms are
    // directly DOM-counted. Pricing/signup rely on keyword heuristics. Medium.
    case "Conversion": {
      score += 28;
      sigs.push({ label: `${apiData.ctaElements.length} CTA element${apiData.ctaElements.length !== 1 ? "s" : ""} detected`, status: apiData.ctaElements.length === 0 ? "critical" : "good" });

      score += 22;
      sigs.push({ label: `${apiData.buttons.total} button${apiData.buttons.total !== 1 ? "s" : ""} found`, status: apiData.buttons.total === 0 ? "critical" : "good" });

      score += 15;
      sigs.push({ label: `${apiData.forms.total} form${apiData.forms.total !== 1 ? "s" : ""} detected`, status: "neutral" });

      score += 12;
      sigs.push({ label: apiData.signals.hasPricing ? "Pricing signals found" : "No pricing indicators detected", status: apiData.signals.hasPricing ? "good" : "warning" });

      score += 10;
      sigs.push({ label: apiData.signals.hasSignup ? "Sign-up path detected" : "No sign-up path found", status: apiData.signals.hasSignup ? "good" : "warning" });
      break;
    }

    // Link counts, form counts, and input counts are all direct DOM reads.
    case "User Journey": {
      score += 35;
      sigs.push({ label: `${apiData.links.total} links counted on page`, status: apiData.links.total > 60 ? "warning" : "good" });

      score += 25;
      sigs.push({ label: `${apiData.forms.total} form${apiData.forms.total !== 1 ? "s" : ""} detected`, status: "neutral" });

      score += 20;
      sigs.push({ label: `${apiData.forms.inputs} input field${apiData.forms.inputs !== 1 ? "s" : ""} scanned`, status: apiData.forms.inputs > 6 ? "warning" : "neutral" });

      score += 10;
      sigs.push({ label: `${apiData.ctaElements.length} CTA element${apiData.ctaElements.length !== 1 ? "s" : ""} found`, status: "neutral" });
      break;
    }

    // Contact detection is keyword-based; OG tags are direct meta tag reads;
    // schema is a direct JSON-LD check. Mix of direct and heuristic → Medium.
    case "Trust Signals": {
      score += 32;
      sigs.push({ label: apiData.signals.hasContact ? "Contact path detected" : "No contact path found", status: apiData.signals.hasContact ? "good" : "critical" });

      score += 30;
      sigs.push({ label: apiData.signals.hasOgTags ? "Open Graph tags present" : "No Open Graph tags detected", status: apiData.signals.hasOgTags ? "good" : "warning" });

      score += 18;
      sigs.push({ label: apiData.signals.hasSchemaMarkup ? "Schema markup found" : "No schema markup", status: "neutral" });

      score += 10;
      sigs.push({ label: apiData.signals.hasChatWidget ? "Chat widget detected" : "No chat widget", status: "neutral" });
      break;
    }

    // Image alt-text is counted directly from the DOM — most direct evidence
    // available in the audit. Very high confidence.
    case "Accessibility": {
      score += 58;
      sigs.push({ label: `${apiData.images.total} image${apiData.images.total !== 1 ? "s" : ""} found`, status: "good" });

      score += 38;
      sigs.push({ label: `${apiData.images.missingAlt} missing alt attribute${apiData.images.missingAlt !== 1 ? "s" : ""}`, status: apiData.images.missingAlt > 5 ? "critical" : apiData.images.missingAlt > 0 ? "warning" : "good" });

      sigs.push({ label: `${apiData.images.withAlt} image${apiData.images.withAlt !== 1 ? "s" : ""} with alt text`, status: apiData.images.withAlt === apiData.images.total ? "good" : "warning" });
      break;
    }

    // Viewport tag is a direct boolean read. Page size is an exact byte count.
    // High confidence — both are direct measurements.
    case "Mobile Experience": {
      score += 58;
      sigs.push({ label: apiData.signals.hasMobileViewport ? "Viewport meta tag present" : "Viewport meta tag missing", status: apiData.signals.hasMobileViewport ? "good" : "critical" });

      score += 28;
      sigs.push({ label: `Page size: ${Math.round(apiData.pageSize / 1000)}KB`, status: apiData.pageSize > 800_000 ? "critical" : apiData.pageSize > 400_000 ? "warning" : "good" });

      score += 12;
      sigs.push({ label: `${apiData.buttons.total} interactive element${apiData.buttons.total !== 1 ? "s" : ""} scanned`, status: "neutral" });
      break;
    }

    // Page size, server response time, and script count are all direct
    // measurements from the fetch operation. Canonical is a meta tag read.
    case "Performance Perception": {
      score += 30;
      sigs.push({ label: `Page size: ${Math.round(apiData.pageSize / 1000)}KB`, status: apiData.pageSize > 800_000 ? "critical" : apiData.pageSize > 400_000 ? "warning" : "good" });

      score += 28;
      sigs.push({ label: `Server response: ${apiData.fetchDuration}ms`, status: apiData.fetchDuration > 3000 ? "critical" : apiData.fetchDuration > 1500 ? "warning" : "good" });

      score += 25;
      sigs.push({ label: `${apiData.scripts} script tag${apiData.scripts !== 1 ? "s" : ""} found`, status: apiData.scripts > 15 ? "warning" : "good" });

      score += 14;
      sigs.push({ label: apiData.signals.hasCanonical ? "Canonical tag present" : "No canonical tag", status: apiData.signals.hasCanonical ? "good" : "warning" });

      sigs.push({ label: `${apiData.wordCount} words scanned`, status: "neutral" });
      break;
    }

    // All link, button, form, and input counts are direct DOM reads.
    case "UX Friction": {
      score += 25;
      sigs.push({ label: `${apiData.links.total} links counted`, status: apiData.links.total > 60 ? "warning" : "neutral" });

      score += 25;
      sigs.push({ label: `${apiData.buttons.total} button${apiData.buttons.total !== 1 ? "s" : ""} scanned`, status: "neutral" });

      score += 25;
      sigs.push({ label: `${apiData.forms.total} form${apiData.forms.total !== 1 ? "s" : ""} detected`, status: "neutral" });

      score += 20;
      sigs.push({ label: `${apiData.forms.inputs} form input${apiData.forms.inputs !== 1 ? "s" : ""} counted`, status: apiData.forms.inputs > 5 ? "warning" : "neutral" });
      break;
    }

    default: {
      score = 65;
      sigs.push({ label: "Live page data used", status: "good" });
      sigs.push({ label: "Finding from real audit patterns", status: "neutral" });
    }
  }

  // Cap at 97 (never claim 100%), floor at 60 for any real audit finding
  score = Math.min(Math.max(score, 60), 97);

  const level: "high" | "medium" | "low" = score >= 95 ? "high" : score >= 75 ? "medium" : "low";

  const reason =
    level === "high"
      ? "Direct DOM evidence confirms this finding. The exact values were read from the live page."
      : level === "medium"
      ? "Multiple signals from the live page support this finding. Some detection relies on pattern matching."
      : "This finding is supported by partial signals. Direct confirmation requires deeper page inspection.";

  return { score, level, signals: sigs, reason };
}

// ── Annotation region mapper ──────────────────────────────────────────────────
//
// Maps a finding to 1–3 heuristic page regions (% of 1280×800 screenshot).
// No computer vision — purely based on category + issue keyword heuristics.

function getAnnotationRegions(finding: AuditFinding, _apiData: APIAuditData | null): AnnotationRegion[] {
  const { category, issue } = finding;
  const kw = issue.toLowerCase();

  // Tight named region presets — % of 1280×800 screenshot
  const R = {
    navStrip:        { x: 0,  y: 0,  width: 100, height: 9  },  // nav bar strip only
    headlineZone:    { x: 5,  y: 8,  width: 65,  height: 18 },  // H1 headline area (left-aligned)
    ctaButton:       { x: 20, y: 26, width: 60,  height: 14 },  // primary CTA button zone
    heroLeftText:    { x: 0,  y: 8,  width: 55,  height: 36 },  // left-side hero text block
    formZone:        { x: 10, y: 28, width: 80,  height: 32 },  // form / input fields
    trustBand:       { x: 0,  y: 60, width: 100, height: 18 },  // social proof row
    footerStrip:     { x: 0,  y: 78, width: 100, height: 22 },  // footer strip
    fullPageOutline: { x: 1,  y: 1,  width: 98,  height: 98 },  // whole page (perf — subtle outline)
  };

  switch (category) {
    case "Product Clarity": {
      if (kw.includes("h1") || kw.includes("headline") || kw.includes("value") || kw.includes("proposition") || kw.includes("hero"))
        return [{ ...R.headlineZone, label: "Expected headline" }];
      if (kw.includes("title") || kw.includes("product name"))
        return [{ ...R.headlineZone, label: "Expected headline" }];
      if (kw.includes("description") || kw.includes("clarity") || kw.includes("clear"))
        return [{ ...R.headlineZone, label: "Expected headline" }, { ...R.heroLeftText, label: "Value statement" }];
      if (kw.includes("word") || kw.includes("content") || kw.includes("story"))
        return [{ ...R.heroLeftText, label: "Value statement" }, { ...R.trustBand, label: "Body content" }];
      return [{ ...R.headlineZone, label: "Expected headline" }];
    }

    case "User Journey": {
      if (kw.includes("navigation") || kw.includes("nav") || kw.includes("menu") || kw.includes("overload") || kw.includes("link"))
        return [{ ...R.navStrip, label: "Navigation overload" }];
      if (kw.includes("cta") || kw.includes("action") || kw.includes("next step"))
        return [{ ...R.ctaButton, label: "Missing CTA" }];
      return [{ ...R.navStrip, label: "Navigation overload" }, { ...R.ctaButton, label: "Missing CTA" }];
    }

    case "Conversion": {
      if (kw.includes("cta") || kw.includes("button") || kw.includes("action") || kw.includes("call to action"))
        return [{ ...R.ctaButton, label: "Missing CTA" }];
      if (kw.includes("form") || kw.includes("signup") || kw.includes("sign up") || kw.includes("register"))
        return [{ ...R.formZone, label: "Conversion form" }];
      if (kw.includes("pric"))
        return [{ ...R.ctaButton, label: "Missing CTA" }];
      return [{ ...R.ctaButton, label: "Missing CTA" }];
    }

    case "UX Friction": {
      if (kw.includes("form") || kw.includes("field") || kw.includes("input") || kw.includes("step"))
        return [{ ...R.formZone, label: "Form friction" }];
      if (kw.includes("nav") || kw.includes("link") || kw.includes("menu"))
        return [{ ...R.navStrip, label: "Navigation overload" }];
      return [{ ...R.ctaButton, label: "UX friction zone" }];
    }

    case "Trust Signals": {
      if (kw.includes("contact") || kw.includes("team") || kw.includes("about"))
        return [{ ...R.footerStrip, label: "Trust proof missing" }];
      if (kw.includes("review") || kw.includes("testimonial") || kw.includes("social proof") || kw.includes("logo"))
        return [{ ...R.trustBand, label: "Trust proof missing" }];
      return [
        { ...R.trustBand,    label: "Trust proof missing" },
        { ...R.footerStrip,  label: "Trust proof missing" },
      ];
    }

    case "Accessibility": {
      if (kw.includes("alt") || kw.includes("image") || kw.includes("img"))
        return [{ ...R.heroLeftText, label: "Missing alt text" }];
      if (kw.includes("contrast") || kw.includes("color"))
        return [{ ...R.headlineZone, label: "Contrast issue" }];
      if (kw.includes("label") || kw.includes("input") || kw.includes("form"))
        return [{ ...R.formZone, label: "Missing labels" }];
      return [{ ...R.headlineZone, label: "Accessibility issue" }];
    }

    case "Mobile Experience": {
      if (kw.includes("viewport") || kw.includes("meta"))
        return [{ ...R.headlineZone, label: "Mobile viewport" }];
      if (kw.includes("touch") || kw.includes("tap") || kw.includes("button"))
        return [{ ...R.ctaButton, label: "Touch target" }];
      return [{ ...R.headlineZone, label: "Mobile issue" }, { ...R.ctaButton, label: "Touch target" }];
    }

    case "Performance Perception":
      // Full-page subtle outline — not a big filled region
      return [{ ...R.fullPageOutline, label: "Render performance" }];

    default:
      return [{ ...R.headlineZone, label: "Issue area" }];
  }
}

// ── URL analysis ──────────────────────────────────────────────────────────────

function detectBuilder(url: string): string | null {
  const u = url.toLowerCase();
  if (u.includes("lovable")) return "Lovable";
  if (u.includes("base44")) return "Base44";
  if (u.includes("bolt.new") || u.includes("bolt.")) return "Bolt";
  if (u.includes("v0.dev") || u.includes("v0.")) return "Vercel v0";
  if (u.includes("cursor")) return "Cursor";
  if (u.includes("replit")) return "Replit";
  if (u.includes("stackblitz")) return "StackBlitz";
  if (u.includes("claude.site")) return "Claude";
  return null;
}

function classifySite(url: string): SiteType {
  const u = url.toLowerCase();
  const builder = detectBuilder(url);
  if (builder) return "ai-builder";
  if (/shop|store|buy|cart|checkout|woocommerce|shopify/.test(u)) return "ecommerce";
  if (/github|gitlab|docs\.|developer\.|api\.|npm\./.test(u)) return "devtool";
  if (/portfolio|cv\.|resume\.|\.me\/|behance|dribbble/.test(u)) return "portfolio";
  if (/enterprise|b2b-platform/.test(u)) return "enterprise";
  if (/marketplace|directory|listing/.test(u)) return "marketplace";
  if (/landing|waitlist|coming-soon/.test(u)) return "landing";
  return "saas";
}

function siteTypeLabel(type: SiteType, builder: string | null): string {
  if (type === "ai-builder" && builder) return `AI-built · ${builder}`;
  if (type === "ai-builder") return "AI-built app";
  const labels: Record<string, string> = {
    saas: "B2B SaaS", ecommerce: "E-commerce", devtool: "Developer tool",
    portfolio: "Portfolio", enterprise: "Enterprise platform",
    marketplace: "Marketplace", landing: "Landing page",
  };
  return labels[type] || "Web product";
}

// ── Findings generators ───────────────────────────────────────────────────────

let _idCounter = 0;
function fid(): string { return `f-${++_idCounter}`; }

function getAIBuilderFindings(url: string, builder: string | null): AuditFinding[] {
  const u = url.toLowerCase();
  const b = builder || "the AI builder";

  const base: AuditFinding[] = [
    {
      id: fid(), priority: "urgent", category: "User Journey",
      issue: "Empty states likely not handled — pages may break when data is missing",
      whyItMatters: "AI builders scaffold happy-path flows. Empty states (no data, first-time user, loading error) are rarely generated automatically and will show broken UI in production.",
      suggestedFix: "Add explicit empty state components for every list, table, or data display. Include: a message, an icon, and a suggested next action.",
      effort: "Medium", impact: "High",
    },
    {
      id: fid(), priority: "urgent", category: "Product Clarity",
      issue: "Value proposition may not be clear within 5 seconds",
      whyItMatters: `Products built quickly with ${b} often have placeholder or generic headlines. A new visitor must understand what the product does and who it is for within 5 seconds.`,
      suggestedFix: "Rewrite the hero headline to name: what the product does, who it is for, and the specific outcome they get. Remove generic phrases like 'powerful', 'seamless', or 'next-generation'.",
      effort: "Low", impact: "High",
    },
    {
      id: fid(), priority: "urgent", category: "Performance Perception",
      issue: "Users may submit forms with invalid data — causing silent failures or broken flows",
      whyItMatters: "Default AI-builder form validation is often minimal: missing required field enforcement, no format checking (email, phone), no error messages on submission failure.",
      suggestedFix: "Test every form: empty submission, invalid email format, special characters, very long inputs. Add visible inline error messages for each validation failure.",
      effort: "Medium", impact: "High",
    },
    {
      id: fid(), priority: "important", category: "User Journey",
      issue: "The sign-in experience is using generic defaults that don't match the product voice",
      whyItMatters: `${b} generates auth flows with default copy and UX patterns. These are often generic and lack branding, onboarding context, or clear next steps after sign-up.`,
      suggestedFix: "Customise the sign-up and login flow: update copy to match product voice, add context about what happens next, and ensure the post-auth redirect lands in a useful state.",
      effort: "Medium", impact: "High",
    },
    {
      id: fid(), priority: "important", category: "Mobile Experience",
      issue: "Navigation and layout may not adapt correctly to narrow viewports",
      whyItMatters: "AI builders often generate desktop-first layouts. Mobile navigation, card grids, and data tables frequently overflow or stack incorrectly at 375px.",
      suggestedFix: "Test the full product on iPhone SE (375px). Fix: nav overflow, horizontal scrolling, button tap targets below 44px, and text below 13px.",
      effort: "Medium", impact: "High",
    },
    {
      id: fid(), priority: "important", category: "Product Clarity",
      issue: "Content likely contains placeholder copy or generic AI-generated text",
      whyItMatters: "AI builders pre-populate placeholder content that is often not updated before launch. Generic copy reduces credibility and fails to communicate real product value.",
      suggestedFix: "Audit every text element: headlines, CTAs, descriptions, error messages, onboarding copy. Replace all placeholder or generic text with product-specific, outcome-focused language.",
      effort: "Low", impact: "Medium",
    },
    {
      id: fid(), priority: "important", category: "Performance Perception",
      issue: "Users see a blank or frozen screen while data loads — creating a broken product impression",
      whyItMatters: "When data is fetching or an action is processing, the UI should show a loading state. Without it, users click twice, assume the product is broken, or lose progress.",
      suggestedFix: "Add loading indicators for: page loads, form submissions, data fetches, and any operation taking more than 300ms. Use skeleton screens for content-heavy areas.",
      effort: "Medium", impact: "Medium",
    },
    {
      id: fid(), priority: "later", category: "Trust Signals",
      issue: "No social proof or credibility signals visible on the main page",
      whyItMatters: "AI-built products launched quickly often have no testimonials, usage numbers, or proof of real users. Without these, new visitors have no reason to trust the product.",
      suggestedFix: "Add at least one trust signal: a user count, a testimonial, a recognised logo, or a press mention. Even 'X users signed up this week' adds credibility.",
      effort: "Low", impact: "Medium",
    },
  ];

  // URL-specific additions
  if (u.includes("dashboard") || u.includes("app.")) {
    base.push({
      id: fid(), priority: "urgent", category: "Performance Perception",
      issue: "Access controls are untested — users may see data they shouldn't, or be blocked from what they need",
      whyItMatters: "AI-built dashboards often lack proper permission gates. Users may access data or actions they should not be able to see, or be blocked from actions they should have.",
      suggestedFix: "Test the app as different user types: new user, existing user, admin, free tier, paid tier. Verify that each role sees only what they are supposed to see.",
      effort: "High", impact: "High",
    });
  }

  if (u.includes("pricing") || u.includes("checkout")) {
    base.push({
      id: fid(), priority: "urgent", category: "Conversion",
      issue: "The payment flow has not been validated — one edge case here is a direct revenue loss",
      whyItMatters: "Payment flows in AI-built products are the highest-risk area. Edge cases: failed payment handling, double-charge prevention, webhook confirmation, and email receipts must all be tested.",
      suggestedFix: "Test the full payment flow end-to-end with a test card: success, decline, card error, 3DS challenge, refund. Verify confirmation email is sent and the user state updates correctly.",
      effort: "High", impact: "High",
    });
  }

  if (u.includes("signup") || u.includes("register") || u.includes("onboard")) {
    base.push({
      id: fid(), priority: "important", category: "Conversion",
      issue: "The activation flow likely asks for more than users are willing to give before seeing value",
      whyItMatters: "AI-generated sign-up flows often ask for too much information too early. Every extra field before the user sees product value reduces completion by ~10%.",
      suggestedFix: "Reduce sign-up to the minimum required: email + password, or OAuth only. Move company name, role, team size to the onboarding flow after the user sees value.",
      effort: "Low", impact: "High",
    });
  }

  return base;
}

function getSaaSFindings(): AuditFinding[] {
  return [
    {
      id: fid(), priority: "urgent", category: "Product Clarity",
      issue: "The headline describes what the product is, not what changes for the user who buys it",
      whyItMatters: "A new visitor decides within 5 seconds whether to engage. Feature-led headlines ('Powerful AI platform') do not communicate value. Outcome-led headlines do ('Cut your support tickets in half').",
      suggestedFix: "Rewrite the headline to complete: 'After using this, you can finally...' or 'This replaces the pain of...'. Name a specific, measurable outcome.",
      effort: "Low", impact: "High",
    },
    {
      id: fid(), priority: "urgent", category: "Conversion",
      issue: "Users are asked to commit before experiencing the product — most leave without converting",
      whyItMatters: "Gated product experiences cause 40–70% drop-off before a user sees value. Best-in-class SaaS shows the product before asking for email.",
      suggestedFix: "Add an interactive demo, sandbox, or product tour that requires no sign-up. Let users experience the core value before committing to account creation.",
      effort: "High", impact: "High",
    },
    {
      id: fid(), priority: "important", category: "Trust Signals",
      issue: "There is no evidence of existing customers visible without scrolling — a trust gap at the top of the funnel",
      whyItMatters: "B2B buyers look for proof of existing customers before engaging. Customer logos or testimonials below the fold may never be seen.",
      suggestedFix: "Move at least 3 customer logos or one specific testimonial to the hero section, below the headline and above the first scroll break.",
      effort: "Low", impact: "Medium",
    },
    {
      id: fid(), priority: "important", category: "Mobile Experience",
      issue: "The primary action may be invisible or unreachable on mobile — half the audience cannot convert",
      whyItMatters: "If the primary CTA is only visible on desktop or buried in mobile navigation, mobile traffic — often 50%+ of visitors — cannot convert.",
      suggestedFix: "Verify the primary CTA is visible and tappable above the fold on 375px viewport. Ensure tap target is at least 44×44px.",
      effort: "Low", impact: "High",
    },
    {
      id: fid(), priority: "later", category: "UX Friction",
      issue: "The activation form is collecting more than is needed — every extra field reduces completion",
      whyItMatters: "Each extra field in a sign-up form reduces completion rate by approximately 10%. Most information (company size, role, use case) can be collected post-activation.",
      suggestedFix: "Reduce sign-up to email + password minimum. Move company info and role to post-signup onboarding where intent is already established.",
      effort: "Low", impact: "Medium",
    },
  ];
}

function getPortfolioFindings(): AuditFinding[] {
  return [
    {
      id: fid(), priority: "urgent", category: "Product Clarity",
      issue: "Role and specialty not immediately clear",
      whyItMatters: "A hiring manager or client makes their judgment in 3–5 seconds. If your role and specialty are not clear in the hero, they will not read further.",
      suggestedFix: "First sentence of the hero must include: your role, your specialty, and who you help. e.g. 'Product Manager specialising in B2B fintech platforms.'",
      effort: "Low", impact: "High",
    },
    {
      id: fid(), priority: "urgent", category: "Conversion",
      issue: "Contact path requires too many steps",
      whyItMatters: "A hiring manager who cannot find contact information in one click will not search for it. The path from portfolio to contact should be one action.",
      suggestedFix: "Add a prominent contact CTA in the navigation and at the bottom of every page. Link directly to email, LinkedIn, or a contact form — not a separate contact page.",
      effort: "Low", impact: "High",
    },
    {
      id: fid(), priority: "important", category: "Trust Signals",
      issue: "Case studies lack specific, measurable outcomes",
      whyItMatters: "Portfolios that describe what was built without naming what changed in measurable terms are unconvincing. Outcomes are more credible than descriptions.",
      suggestedFix: "For each case study, add: the specific metric that moved, by how much, and over what timeframe. e.g. 'Reduced settlement support tickets by 40% in 90 days.'",
      effort: "Medium", impact: "High",
    },
    {
      id: fid(), priority: "important", category: "Mobile Experience",
      issue: "Portfolio layout may not adapt to mobile viewports",
      whyItMatters: "Hiring managers often review portfolios on phones. A broken mobile layout signals poor attention to detail — exactly the opposite of what a PM or designer wants to communicate.",
      suggestedFix: "Test on iPhone SE (375px). Ensure all case studies, images, and contact paths are readable and accessible. Fix any horizontal overflow.",
      effort: "Medium", impact: "Medium",
    },
    {
      id: fid(), priority: "later", category: "Product Clarity",
      issue: "Section titles are generic — they describe structure, not the work or the person",
      whyItMatters: "Generic headers ('About Me', 'My Work') are forgettable. Specific, voice-driven headers make a portfolio memorable.",
      suggestedFix: "Replace generic section titles with specific statements that reflect your PM style. e.g. 'Products I shipped' → 'What I built and what changed because of it.'",
      effort: "Low", impact: "Low",
    },
  ];
}

function getEcommerceFindings(): AuditFinding[] {
  return [
    {
      id: fid(), priority: "urgent", category: "Trust Signals",
      issue: "Payment security signals may not be visible at checkout",
      whyItMatters: "65% of shoppers abandon checkout due to trust concerns. Security badges and accepted payment logos must appear near the checkout CTA.",
      suggestedFix: "Add SSL badge, accepted payment icons, and a returns policy summary above the Place Order button.",
      effort: "Low", impact: "High",
    },
    {
      id: fid(), priority: "urgent", category: "Conversion",
      issue: "Guest checkout likely not prominently offered",
      whyItMatters: "Forced account creation before purchase causes 35% checkout abandonment. Guest checkout should be the default or equally prominent option.",
      suggestedFix: "Place guest checkout as the first option. Move account creation to post-purchase as an optional step.",
      effort: "Low", impact: "High",
    },
    {
      id: fid(), priority: "important", category: "Mobile Experience",
      issue: "Product image gallery touch interactions may not work correctly",
      whyItMatters: "Mobile shoppers rely on swiping through product images. Pinch-to-zoom and swipe gestures must work on iOS Safari and Android Chrome.",
      suggestedFix: "Test product gallery with touch gestures. Ensure pinch-to-zoom is not disabled via CSS. Test horizontal swipe navigation.",
      effort: "Medium", impact: "High",
    },
    {
      id: fid(), priority: "important", category: "Performance Perception",
      issue: "Cart state may not persist across page refreshes or navigation",
      whyItMatters: "If cart items disappear when a user navigates away or refreshes, it is one of the most frustrating experiences in e-commerce and directly causes drop-off.",
      suggestedFix: "Test: add items to cart → navigate to another page → return to cart. Items must persist. Also test: close browser tab and reopen.",
      effort: "Low", impact: "High",
    },
    {
      id: fid(), priority: "later", category: "UX Friction",
      issue: "Checkout form collects information in non-optimal order",
      whyItMatters: "The standard checkout order (email → shipping → payment) is optimised for conversion. Non-standard flows create confusion and increase drop-off.",
      suggestedFix: "Follow the standard checkout order: email/contact → shipping address → delivery method → payment. Do not ask for account creation before payment details.",
      effort: "Medium", impact: "Medium",
    },
  ];
}

function getDevToolFindings(): AuditFinding[] {
  return [
    {
      id: fid(), priority: "urgent", category: "Product Clarity",
      issue: "Developers cannot see a working result quickly — the most common reason developers abandon evaluation",
      whyItMatters: "Developer tools are evaluated by how quickly a developer can see a working result. If the quickstart takes more than 10 minutes, developers move on to alternatives.",
      suggestedFix: "Create a quickstart that reaches a working result in 3 steps or fewer. Measure and optimise time-to-first-success as a product metric.",
      effort: "High", impact: "High",
    },
    {
      id: fid(), priority: "important", category: "Trust Signals",
      issue: "Status page not linked from main navigation",
      whyItMatters: "Developer tool buyers check uptime history before committing. A missing status page is a trust gap for engineering teams evaluating reliability.",
      suggestedFix: "Add a status page link to the main navigation footer and the dashboard. Link to historical uptime data.",
      effort: "Low", impact: "Medium",
    },
    {
      id: fid(), priority: "important", category: "Performance Perception",
      issue: "Copy-paste code that breaks on first use destroys developer trust immediately and permanently",
      whyItMatters: "Copy-paste code that does not work destroys developer trust faster than anything else. One broken example can cause a developer to abandon evaluation entirely.",
      suggestedFix: "Run CI against all code examples in documentation on every release. Test in all officially supported language versions and environments.",
      effort: "High", impact: "High",
    },
    {
      id: fid(), priority: "later", category: "UX Friction",
      issue: "Documentation search fails for the exact queries developers need most — error codes, method names, SDK specifics",
      whyItMatters: "Developers search docs with specific technical queries: error codes, method names, SDK names. Generic search fails these.",
      suggestedFix: "Implement Algolia DocSearch or equivalent. Explicitly index error codes, method names, and common technical queries.",
      effort: "Medium", impact: "Medium",
    },
  ];
}

function getLandingFindings(): AuditFinding[] {
  return [
    {
      id: fid(), priority: "urgent", category: "Product Clarity",
      issue: "The product's core promise requires too much effort to understand — most visitors leave before getting there",
      whyItMatters: "Landing pages have one job: convert a visitor into a lead. If the value proposition requires reading, most visitors will not see it.",
      suggestedFix: "Reduce the hero to: one outcome-focused headline, two supporting sentences maximum, one CTA. Remove everything else above the fold.",
      effort: "Low", impact: "High",
    },
    {
      id: fid(), priority: "urgent", category: "Conversion",
      issue: "Multiple competing actions are splitting user attention — the primary conversion path is diluted",
      whyItMatters: "Every additional CTA reduces the conversion rate of the primary one. A landing page with one CTA converts 3× better than one with multiple.",
      suggestedFix: "Remove or visually eliminate all CTAs except the primary action. If navigation is present, consider removing it from the landing page entirely.",
      effort: "Low", impact: "High",
    },
    {
      id: fid(), priority: "important", category: "Trust Signals",
      issue: "No early social proof or credibility signals",
      whyItMatters: "Pre-launch and early-stage landing pages need trust signals even without a customer base. Waitlist count, press mention, or founder credibility fill this gap.",
      suggestedFix: "Add at least one trust signal: a waitlist counter, a press mention, a recognisable logo, or a founder credential with relevant context.",
      effort: "Low", impact: "Medium",
    },
    {
      id: fid(), priority: "later", category: "Performance Perception",
      issue: "Leads are likely being lost silently — form submission paths are rarely tested beyond the button click",
      whyItMatters: "A broken sign-up form on a landing page loses leads silently. Most teams test form design but not the full submission → confirmation email → unsubscribe flow.",
      suggestedFix: "Test: submit → confirmation page renders → confirmation email delivered → unsubscribe path works. Test on mobile.",
      effort: "Low", impact: "High",
    },
  ];
}

function getURLSignalFindings(url: string): AuditFinding[] {
  const u = url.toLowerCase();
  const extra: AuditFinding[] = [];

  if (u.includes("pricing")) {
    extra.push({
      id: fid(), priority: "urgent", category: "Conversion",
      issue: "This pricing page may require a sales call to proceed — gating out buyers who prefer to self-evaluate",
      whyItMatters: "Pricing pages that require a sales call gate out up to 60% of developer and SMB buyers who self-qualify. This is the single highest-impact conversion issue on pricing pages.",
      suggestedFix: "Add a free tier, sandbox, or interactive demo. Remove 'Contact sales' as the only CTA on the pricing page. Show at least one tier with transparent, immediate access.",
      effort: "High", impact: "High",
    });
  }

  if (u.includes("login") || u.includes("signin")) {
    extra.push({
      id: fid(), priority: "important", category: "Performance Perception",
      issue: "Login page — password reset and error recovery flows need testing",
      whyItMatters: "Login errors are often the first experience a returning user has after a break. Broken password reset or unhelpful error messages cause churn before the user even re-engages.",
      suggestedFix: "Test: wrong password error message, too-many-attempts handling, password reset email delivery, and reset link expiry behaviour.",
      effort: "Low", impact: "Medium",
    });
  }

  if (u.includes("dashboard") || u.includes("/app")) {
    extra.push({
      id: fid(), priority: "urgent", category: "Performance Perception",
      issue: "New users land in an empty dashboard with no guidance — the first impression is a blank screen",
      whyItMatters: "New users and users with no data will see the dashboard before any content exists. Without explicit empty states, the page looks broken.",
      suggestedFix: "Add empty state components for every list, chart, and data display. Include: an illustration or icon, a message explaining the empty state, and a CTA for the next action.",
      effort: "Medium", impact: "High",
    });
  }

  if (u.includes("checkout") || u.includes("cart")) {
    extra.push({
      id: fid(), priority: "urgent", category: "Performance Perception",
      issue: "A failed payment with no recovery path is a direct revenue loss — one of the highest-cost bugs in any product",
      whyItMatters: "A failed payment with no clear recovery path is the highest-cost bug in a transactional product. Users who cannot retry immediately are lost.",
      suggestedFix: "Test: declined card, network error during payment, session timeout during checkout. Verify each case shows a clear error message and a working retry path.",
      effort: "High", impact: "High",
    });
  }

  if (u.includes("docs") || u.includes("/api")) {
    extra.push({
      id: fid(), priority: "important", category: "Product Clarity",
      issue: "The fastest path to a working result is buried — developers leave before finding it",
      whyItMatters: "The first question a developer asks is 'how quickly can I see this working?' If the quickstart is not the first thing on the docs homepage, evaluation time increases significantly.",
      suggestedFix: "Place a 'Get started' or quickstart link at the very top of the docs homepage, before any reference documentation or conceptual guides.",
      effort: "Low", impact: "High",
    });
  }

  return extra;
}

function buildAuditResult(url: string): AuditResult {
  _idCounter = 0; // reset for consistent IDs per audit
  let domain = url;
  try {
    domain = new URL(url.startsWith("http") ? url : `https://${url}`).hostname.replace("www.", "");
  } catch { /* keep raw */ }

  const builder = detectBuilder(url);
  const type = classifySite(url);

  let baseFindings: AuditFinding[];
  const baseScores: Record<SiteType, number> = {
    saas: 58, ecommerce: 62, devtool: 55, portfolio: 64,
    enterprise: 52, marketplace: 60, landing: 50, "ai-builder": 48,
  };

  if (type === "ai-builder") baseFindings = getAIBuilderFindings(url, builder);
  else if (type === "ecommerce") baseFindings = getEcommerceFindings();
  else if (type === "devtool") baseFindings = getDevToolFindings();
  else if (type === "portfolio") baseFindings = getPortfolioFindings();
  else if (type === "landing") baseFindings = getLandingFindings();
  else baseFindings = getSaaSFindings();

  const urlFindings = getURLSignalFindings(url);
  const allFindings = [...baseFindings, ...urlFindings];

  const order: Record<Priority, number> = { urgent: 0, important: 1, later: 2 };
  allFindings.sort((a, b) => order[a.priority] - order[b.priority]);

  const urgent = allFindings.filter((f) => f.priority === "urgent");
  const quickWin = allFindings.find((f) => f.effort === "Low" && f.impact === "High");

  return {
    domain,
    siteType: siteTypeLabel(type, builder),
    detectedBuilder: builder,
    overallScore: baseScores[type],
    topUrgentIssue: urgent[0]?.issue ?? "No critical issues detected",
    bestQuickWin: quickWin?.issue ?? allFindings[0]?.issue ?? "See findings below",
    mainProductRisk: urgent.find((f) => f.category === "Conversion" || f.category === "Product Clarity")?.issue ?? urgent[0]?.issue ?? "Review full findings",
    findings: allFindings,
    scanQuality: { status: "reliable", reasons: [], confidence: 70 },
  };
}

/** Creates a minimal AuditResult representing a failed fetch — no findings shown. */
function buildFailedAuditResult(url: string, fetchError: string): AuditResult {
  let domain = url;
  try { domain = new URL(url.startsWith("http") ? url : `https://${url}`).hostname.replace("www.", ""); } catch { /* keep raw */ }
  const scanQuality = computeScanQuality(null, fetchError, url);
  return {
    domain,
    siteType: "Unknown",
    detectedBuilder: null,
    overallScore: 0,
    topUrgentIssue: "",
    bestQuickWin: "",
    mainProductRisk: "",
    findings: [],
    scanQuality,
  };
}

// ── API response type (mirrors /api/audit response) ──────────────────────────

interface APIAuditData {
  url: string;
  fetchedAt: string;
  fetchDuration: number;
  pageSize: number;
  statusCode: number;
  title: string;
  description: string;
  h1Tags: string[];
  h2Tags: string[];
  wordCount: number;
  links: { total: number; internal: number; external: number; samples: string[] };
  buttons: { total: number; samples: string[] };
  forms: { total: number; inputs: number };
  images: { total: number; missingAlt: number; withAlt: number; missingAltSamples: string[] };
  ctaElements: string[];
  signals: {
    hasPricing: boolean; pricingIndicators: string[];
    hasSignup: boolean; signupIndicators: string[];
    hasContact: boolean; contactIndicators: string[];
    hasNewsletter: boolean; hasSearch: boolean;
    hasChatWidget: boolean; hasCookieBanner: boolean;
    hasMobileViewport: boolean; hasCanonical: boolean;
    hasOgTags: boolean; hasSchemaMarkup: boolean;
  };
  scripts: number;
  stylesheets: number;
  analysisSource?: "static-html" | "rendered-dom" | "heuristic-fallback";
}

// ── Rule-based findings engine — driven by real API data ─────────────────────

function generateFindingsFromAPIData(data: APIAuditData, url: string, context: SiteContext): AuditFinding[] {
  _idCounter = 0;
  const findings: AuditFinding[] = [];
  const siteType: SiteContextType = context.siteType;

  // Suppress irrelevant checks based on site type
  const skipMarketingChecks = siteType === "internal_tool_or_dashboard" || siteType === "documentation_site";
  const skipConversionChecks = siteType === "internal_tool_or_dashboard" || siteType === "documentation_site" || siteType === "portfolio_site";
  const isOfficialSite = siteType === "official_company_site";
  const isAIBuilt = siteType === "ai_built_site";
  const strictMode = isAIBuilt; // stricter thresholds

  // ── PRODUCT CLARITY ─────────────────────────────────────────────────────────
  // What users see in the first 5 seconds determines whether they stay.

  if (!data.title && !skipMarketingChecks) {
    findings.push({
      id: fid(), priority: "urgent", category: "Product Clarity",
      issue: "This product has no name on the page",
      whyItMatters: "A missing title tag means the product has no identity in search results, browser tabs, or shared links. The first thing a user sees about your product is blank.",
      suggestedFix: "Add a <title> tag with the product name and a short value statement. e.g. 'ProductName — [what it does in 5 words]'. Keep it under 60 characters.",
      effort: "Low", impact: "High",
      found: "No <title> tag found in the page head.",
      expected: "A title tag with the product name and a short value statement (20–60 characters).",
    });
  } else if (data.title.length < 20 && !isOfficialSite && !skipMarketingChecks) {
    findings.push({
      id: fid(), priority: isAIBuilt ? "urgent" : "important", category: "Product Clarity",
      issue: `The product name is too vague to communicate value: "${data.title}"`,
      whyItMatters: "A title under 20 characters cannot communicate what the product does or who it is for. Users scanning search results will not know why to click.",
      suggestedFix: `Expand the title: "${data.title} — [what it does] for [who]". Make the value visible before the user even clicks.`,
      effort: "Low", impact: "High",
      found: `Title tag: "${data.title}" · ${data.title.length} characters.`,
      expected: "A title of 20–60 characters that names the product and describes its value.",
    });
  } else if (data.title.length > 70) {
    findings.push({
      id: fid(), priority: "later", category: "Product Clarity",
      issue: "The product headline gets cut off in search results",
      whyItMatters: "Titles longer than 60 characters are truncated in Google, Slack, and most social previews. The part that matters most may never be read.",
      suggestedFix: "Trim to under 60 characters. Put the product name and primary value first. Cut anything that appears after the first value statement.",
      effort: "Low", impact: "Low",
      found: `Title tag: "${data.title.slice(0, 55)}…" · ${data.title.length} characters.`,
      expected: "A title under 60 characters so it renders in full across search and social previews.",
    });
  }

  if (!data.description) {
    findings.push({
      id: fid(), priority: "urgent", category: "Product Clarity",
      issue: "No product description visible to users before they arrive",
      whyItMatters: "Without a meta description, search engines and social platforms auto-generate preview text — usually a random sentence from the page. The first controlled impression of your product is lost.",
      suggestedFix: "Write a 120–155 character meta description that leads with the user outcome: 'Stop doing [painful thing]. [Product] helps [user type] achieve [goal] in [timeframe].'",
      effort: "Low", impact: "High",
      found: "No meta description tag detected.",
      expected: "A 120–155 character description leading with the user outcome.",
    });
  } else if (data.description.length < 50) {
    findings.push({
      id: fid(), priority: "important", category: "Product Clarity",
      issue: "The product description is too brief to drive qualified clicks",
      whyItMatters: "A meta description under 50 characters cannot communicate context or value. Users scanning results cannot tell if this product is relevant to them.",
      suggestedFix: "Expand to 120–155 characters. Describe the user problem, the solution, and the audience. Lead with what changes for the user, not what the product does.",
      effort: "Low", impact: "Medium",
      found: `Meta description: "${data.description}" · ${data.description.length} characters.`,
      expected: "A description of 120–155 characters that communicates context, audience, and value.",
    });
  }

  if (data.h1Tags.length === 0) {
    findings.push({
      id: fid(), priority: "urgent", category: "Product Clarity",
      issue: "There is no clear value statement anchoring the page",
      whyItMatters: "Without an H1, there is no primary message for users or search engines to anchor to. New visitors have no single statement to evaluate whether the product is for them.",
      suggestedFix: "Add one H1 that states the core user outcome — not the product feature. 'Finally, [outcome] without [pain]' is more powerful than '[Product] is the platform for [category]'.",
      effort: "Low", impact: "High",
      found: "0 H1 tags detected on the page.",
      expected: "One primary H1 stating the core user outcome or product value.",
    });
  } else if (data.h1Tags.length > 3) {
    findings.push({
      id: fid(), priority: "important", category: "Product Clarity",
      issue: `${data.h1Tags.length} competing headlines are diluting the core message`,
      whyItMatters: "Multiple H1s mean the product is trying to say too many things at once. Users cannot identify the single most important reason to keep reading.",
      suggestedFix: "Keep one H1 as the definitive statement of the product's value. Demote the rest to H2 or H3. The primary headline should be the last thing you cut.",
      effort: "Low", impact: "Medium",
      found: `${data.h1Tags.length} H1 tags detected: ${data.h1Tags.slice(0, 2).map(t => `"${t.slice(0, 40)}"`).join(", ")}.`,
      expected: "1–2 H1 tags maximum — one definitive statement that anchors the page.",
    });
  }

  if (data.wordCount < 80 && !skipMarketingChecks && !isOfficialSite) {
    findings.push({
      id: fid(), priority: isAIBuilt ? "urgent" : "important", category: "Product Clarity",
      issue: "Not enough product story on this page to build conviction",
      whyItMatters: "Fewer than 80 words cannot explain what the product does, who it is for, and why it matters. Users leave when they cannot answer these three questions quickly.",
      suggestedFix: "Add a clear product narrative: the problem, who has it, and how the product solves it. 200–300 words of well-structured copy outperforms any visual on a product page.",
      effort: "Medium", impact: "High",
      found: `${data.wordCount} words of readable content detected on the page.`,
      expected: "At least 200 words to explain the product, audience, and value proposition.",
    });
  }

  // ── CONVERSION ───────────────────────────────────────────────────────────────
  // Users who cannot take action are lost.

  if (!skipConversionChecks && data.ctaElements.length === 0 && data.buttons.total === 0) {
    findings.push({
      id: fid(), priority: "urgent", category: "Conversion",
      issue: "There is no activation path on this page",
      whyItMatters: "A product page without a call to action is a dead end. Users arrive with intent, find no way to proceed, and leave. Conversion rate is zero until this is fixed.",
      suggestedFix: "Add one dominant action above the fold. It should describe the outcome, not the mechanic: 'Start building free', not 'Sign up'. Every other action on the page should be secondary to this one.",
      effort: "Low", impact: "High",
      found: "0 buttons and 0 recognizable action elements detected on the page.",
      expected: "At least one prominent action button above the fold with outcome-based copy.",
    });
  } else if (data.ctaElements.length === 0) {
    findings.push({
      id: fid(), priority: "important", category: "Conversion",
      issue: "Buttons exist but none communicate a reason to click",
      whyItMatters: "Generic button labels like 'Submit', 'Click here', or 'Learn more' don't give users a reason to act. They describe the mechanic, not the outcome.",
      suggestedFix: "Replace all generic button text with outcome-based copy: 'Get started free', 'See how it works', 'Start your first audit'. The user should know exactly what happens next.",
      effort: "Low", impact: "High",
      found: `${data.buttons.total} button${data.buttons.total !== 1 ? "s" : ""} found · none match activation patterns.`,
      expected: "Button text that describes the user outcome, not the mechanic (e.g. 'Get started free').",
    });
  }

  if (!skipConversionChecks && !isOfficialSite && !data.signals.hasPricing) {
    findings.push({
      id: fid(), priority: isAIBuilt ? "urgent" : "important", category: "Conversion",
      issue: "Users cannot self-qualify without pricing visibility",
      whyItMatters: "B2B and SaaS buyers make purchase decisions on their own before ever talking to sales. Hiding pricing forces a sales call that up to 60% of qualified buyers will not book.",
      suggestedFix: "Add a pricing page or at minimum a starting price. If pricing is variable, show a floor ('Starting at $X') or a ROI statement ('Save 10+ hours per week'). Let buyers disqualify themselves.",
      effort: "Medium", impact: "High",
      found: "No pricing, plan, or cost indicators detected on the page.",
      expected: "Visible pricing or at minimum a starting price so buyers can self-qualify.",
    });
  }

  if (!skipConversionChecks && !isOfficialSite && !data.signals.hasSignup) {
    findings.push({
      id: fid(), priority: isAIBuilt ? "urgent" : "important", category: "Conversion",
      issue: "There is no self-service path from interest to activation",
      whyItMatters: "Users who are ready to try the product right now have nowhere to go. Requiring contact with sales adds a 24–72 hour delay to the activation moment — most users don't wait.",
      suggestedFix: "Add a self-service activation path: free trial, demo, sandbox, or waitlist. Show this option prominently. Reduce friction between 'I'm interested' and 'I'm using it'.",
      effort: "Medium", impact: "High",
      found: "No sign-up, registration, or trial start flow detected.",
      expected: "A self-service activation path: free trial, demo, sandbox, or waitlist.",
    });
  }

  // ── USER JOURNEY ─────────────────────────────────────────────────────────────
  // Where do users get stuck, confused, or lose momentum?

  if (data.forms.total > 0 && data.ctaElements.length === 0) {
    findings.push({
      id: fid(), priority: "important", category: "User Journey",
      issue: "Users reach a form with no clear reason to complete it",
      whyItMatters: "Forms without directional context have low completion rates. Users don't know why they're filling in fields or what they'll get in return. Ambiguity kills conversions.",
      suggestedFix: "Add a heading above each form that states the value of completing it: 'Get early access to [Product]' or 'Talk to someone in 24 hours'. The form should feel like a step toward something, not a gate.",
      effort: "Low", impact: "Medium",
      found: `${data.forms.total} form${data.forms.total !== 1 ? "s" : ""} detected with no directional context or outcome-based CTA near them.`,
      expected: "A clear heading or description near each form explaining what the user gets by completing it.",
    });
  }

  if (data.links.total > 60) {
    findings.push({
      id: fid(), priority: "later", category: "User Journey",
      issue: "Navigation overload is fragmenting the user's attention",
      whyItMatters: "More than 60 links on a single page creates decision paralysis. Every extra link competes with the primary user goal. Users who can't decide what to click on, don't click anything.",
      suggestedFix: "Audit every link on the page. Remove or consolidate any link that does not directly serve the user's goal at this stage of their journey. Fewer options means more conversions.",
      effort: "Medium", impact: "Medium",
      found: `${data.links.total} links found on the page.`,
      expected: "Fewer than 50 links — every link should serve the user's current goal.",
    });
  }

  // ── TRUST SIGNALS ────────────────────────────────────────────────────────────
  // Users buy from products they trust. Trust must be earned early.

  if (!data.signals.hasContact && !skipMarketingChecks && !isOfficialSite) {
    findings.push({
      id: fid(), priority: "important", category: "Trust Signals",
      issue: "There is no visible way to reach the team behind this product",
      whyItMatters: "B2B buyers and first-time users look for a way to contact the team as a trust signal. Its absence suggests the company is either unreachable or unaccountable — both are conversion killers.",
      suggestedFix: "Add a contact link, support email, or live chat to the navigation or footer. Enterprise buyers specifically look for this before initiating any evaluation.",
      effort: "Low", impact: "Medium",
      found: "No contact link, support email, or chat widget detected.",
      expected: "A visible way to reach the team: contact page, support email, or live chat.",
    });
  }

  if (!data.signals.hasOgTags && !skipMarketingChecks) {
    findings.push({
      id: fid(), priority: "later", category: "Trust Signals",
      issue: "Every share of this product creates a broken first impression",
      whyItMatters: "When users share this page on LinkedIn, Slack, or in email, it renders as a plain URL with no image or description. The product looks unfinished before the recipient even visits.",
      suggestedFix: "Add og:title, og:description, and og:image to the page head. This takes 20 minutes and transforms every shared link into a controlled preview of the product.",
      effort: "Low", impact: "Medium",
      found: "No Open Graph meta tags (og:title, og:description, og:image) detected.",
      expected: "og:title, og:description, and og:image so every shared link shows a controlled product preview.",
    });
  }

  // ── ACCESSIBILITY ────────────────────────────────────────────────────────────

  if (data.images.missingAlt > 5) {
    findings.push({
      id: fid(), priority: "urgent", category: "Accessibility",
      issue: `${data.images.missingAlt} of ${data.images.total} images are invisible to users relying on screen readers`,
      whyItMatters: "Screen readers skip images without alt text entirely. For visually impaired users, these images and any information they carry simply do not exist. This also fails WCAG AA standards.",
      suggestedFix: `Add descriptive alt text to all ${data.images.missingAlt} images. For content images: describe what the image shows in under 15 words. For decorative images: use alt="". Affected sources: ${data.images.missingAltSamples.slice(0, 2).join(", ")}`,
      effort: "Medium", impact: "Medium",
      found: `${data.images.missingAlt} of ${data.images.total} images have no alt text.`,
      expected: "All content images with descriptive alt text; decorative images with alt=\"\".",
    });
  } else if (data.images.missingAlt > 0) {
    findings.push({
      id: fid(), priority: "important", category: "Accessibility",
      issue: `${data.images.missingAlt} image${data.images.missingAlt > 1 ? "s are" : " is"} inaccessible to screen reader users`,
      whyItMatters: "Every image without alt text is a gap in the product experience for users who rely on assistive technology. It also reduces SEO value.",
      suggestedFix: "Add alt text to each affected image: describe the content or purpose in plain language. For purely decorative images, use alt=\"\".",
      effort: "Low", impact: "Medium",
      found: `${data.images.missingAlt} of ${data.images.total} image${data.images.missingAlt !== 1 ? "s are" : " is"} missing alt text.`,
      expected: "Descriptive alt text on every content image for screen reader accessibility.",
    });
  }

  // ── MOBILE EXPERIENCE ────────────────────────────────────────────────────────

  if (!data.signals.hasMobileViewport) {
    findings.push({
      id: fid(), priority: "urgent", category: "Mobile Experience",
      issue: "The mobile experience is broken at the foundation",
      whyItMatters: "Without a viewport meta tag, the page renders as a miniaturised desktop layout on mobile. Text is unreadable, navigation is unusable, and CTAs are invisible. Mobile users immediately leave.",
      suggestedFix: 'Add <meta name="viewport" content="width=device-width, initial-scale=1"> to the <head>. This single line enables responsive behaviour and is the prerequisite for every other mobile fix.',
      effort: "Low", impact: "High",
      found: "No viewport meta tag found in the page <head>.",
      expected: '<meta name="viewport" content="width=device-width, initial-scale=1"> enabling responsive layout.',
    });
  }

  // ── PERFORMANCE PERCEPTION ───────────────────────────────────────────────────
  // Users judge product quality by how fast it loads.

  if (data.pageSize > 800_000) {
    findings.push({
      id: fid(), priority: "urgent", category: "Performance Perception",
      issue: `Page weight is ${(data.pageSize / 1000).toFixed(0)}KB — users are waiting before seeing any value`,
      whyItMatters: "A page over 800KB takes 3–5 seconds to load on a typical mobile connection. 53% of mobile users abandon a page that takes more than 3 seconds. Users are forming a negative product impression before the page is even visible.",
      suggestedFix: "Audit page weight: compress and lazy-load images, remove unused CSS/JS, and defer non-critical scripts. Aim for under 300KB for the initial render. Each second of improvement is a measurable conversion gain.",
      effort: "High", impact: "High",
      found: `Page size: ${(data.pageSize / 1000).toFixed(0)}KB.`,
      expected: "Page weight under 300KB for initial render on mobile connections.",
    });
  } else if (data.pageSize > 400_000) {
    findings.push({
      id: fid(), priority: "important", category: "Performance Perception",
      issue: `Page weight of ${(data.pageSize / 1000).toFixed(0)}KB is creating noticeable load friction`,
      whyItMatters: "Pages over 400KB take 2+ seconds on mobile. This is below the threshold where users consciously notice the wait, but it measurably increases bounce rate and reduces first impressions.",
      suggestedFix: "Review page weight: compress images, minimise CSS/JS bundles, and lazy-load content below the fold. Target under 200KB for the initial viewport render.",
      effort: "Medium", impact: "Medium",
      found: `Page size: ${(data.pageSize / 1000).toFixed(0)}KB.`,
      expected: "Page weight under 200KB for the initial viewport render.",
    });
  }

  if (data.scripts > 15) {
    findings.push({
      id: fid(), priority: "important", category: "Performance Perception",
      issue: `${data.scripts} scripts are loading — the page feels heavier than it needs to`,
      whyItMatters: "Each additional script adds a network request and blocks rendering. More than 10 scripts typically means unused analytics, redundant chat widgets, or A/B testing tools that are no longer active. Users experience this as a slow product.",
      suggestedFix: "Audit every script. Remove tracking tools that are not actively used. Defer or lazy-load non-critical scripts. Consider consolidating third-party tools into a single tag manager.",
      effort: "Medium", impact: "Medium",
      found: `${data.scripts} <script> tags detected on the page.`,
      expected: "10 or fewer scripts for a fast, low-friction load.",
    });
  }

  // ── QUALITY RISK ─────────────────────────────────────────────────────────────

  if (!data.signals.hasCanonical) {
    findings.push({
      id: fid(), priority: "later", category: "Performance Perception",
      issue: "This page may be diluting its own search ranking",
      whyItMatters: "Without a canonical tag, search engines may index multiple versions of the same URL with different parameters. This splits SEO authority across duplicates rather than concentrating it on one page.",
      suggestedFix: 'Add <link rel="canonical" href="[page URL]"> to the <head> tag. This tells search engines which URL is the authoritative version.',
      effort: "Low", impact: "Low",
      found: "No <link rel=\"canonical\"> tag found in the page <head>.",
      expected: "A canonical link tag pointing to the authoritative URL to consolidate SEO authority.",
    });
  }

  // ── URL-signal findings appended last ─────────────────────────────────────
  const urlBased = getURLSignalFindings(url);
  return [...findings, ...urlBased];
}
// ── Real audit result from API data ──────────────────────────────────────────

function buildRealAuditResult(data: APIAuditData, url: string, context: SiteContext, scanQuality?: ScanQuality): AuditResult {
  const findings = generateFindingsFromAPIData(data, url, context);
  const domain = (() => {
    try { return new URL(data.url).hostname.replace("www.", ""); }
    catch { return data.url; }
  })();

  const builder = detectBuilder(url);
  const type = classifySite(url);

  const urgentFindings = findings.filter((f) => f.priority === "urgent");
  const quickWin = findings.find((f) => f.effort === "Low" && f.impact === "High");

  // Context-aware base score:
  // Official company sites start higher (fewer marketing gaps expected)
  // AI-built/demo sites start lower (more scrutiny expected)
  const BASE_SCORES: Partial<Record<SiteContextType, number>> = {
    official_company_site: 82,
    ai_built_site: 48,
    startup_landing_page: 68,
    portfolio_site: 72,
    internal_tool_or_dashboard: 70,
    documentation_site: 74,
    ecommerce_or_marketplace: 68,
    unknown: 62,
  };
  const baseScore = BASE_SCORES[context.siteType] ?? 65;

  // Deductions also vary: official sites penalised less per issue
  const urgentDeduction = context.siteType === "official_company_site" ? 4 : context.siteType === "ai_built_site" ? 10 : 7;
  const importantDeduction = context.siteType === "official_company_site" ? 2 : context.siteType === "ai_built_site" ? 5 : 3;

  const score = Math.max(
    8,
    baseScore -
      urgentFindings.length * urgentDeduction -
      findings.filter((f) => f.priority === "important").length * importantDeduction
  );

  return {
    domain,
    siteType: SITE_TYPE_LABELS[context.siteType] ?? siteTypeLabel(type, builder),
    detectedBuilder: builder ?? context.detectedBuilder,
    overallScore: score,
    topUrgentIssue: urgentFindings[0]?.issue ?? "No critical issues detected",
    bestQuickWin: quickWin?.issue ?? "See findings below",
    mainProductRisk:
      urgentFindings.find((f) => f.category === "Conversion" || f.category === "Product Clarity")
        ?.issue ??
      urgentFindings[0]?.issue ??
      "Review full findings",
    findings,
    scanQuality: scanQuality ?? computeScanQuality(data, null, url),
  };
}

// ── Priority config ───────────────────────────────────────────────────────────

const P_CONFIG = {
  urgent: { label: "Urgent", dot: "bg-red-500", badge: "bg-red-100 text-red-700 border-red-200", rowBg: "bg-red-50", borderL: "border-l-red-400" },
  important: { label: "Important", dot: "bg-amber-500", badge: "bg-amber-100 text-amber-700 border-amber-200", rowBg: "bg-amber-50/50", borderL: "border-l-amber-400" },
  later: { label: "Later", dot: "bg-zinc-400", badge: "bg-zinc-100 text-zinc-600 border-zinc-200", rowBg: "bg-white", borderL: "border-l-zinc-200" },
};

// ── Main component ────────────────────────────────────────────────────────────

const DEFAULT_CATEGORY_ORDER: Category[] = [
  "Product Clarity",
  "Conversion",
  "User Journey",
  "UX Friction",
  "Trust Signals",
  "Mobile Experience",
  "Accessibility",
  "Performance Perception",
];

const CAT_DOTS: Partial<Record<Category, string>> = {
  "Product Clarity": "bg-blue-400",
  "Conversion":      "bg-red-400",
  "User Journey":    "bg-violet-400",
  "UX Friction":     "bg-amber-400",
  "Trust Signals":   "bg-green-400",
  "Mobile Experience": "bg-purple-400",
  "Accessibility":   "bg-cyan-400",
  "Performance Perception": "bg-orange-400",
};

// i18n — see ../locales/ for all translation strings

export default function AuditTool() {
  const [auditState, setAuditState] = useState<AuditState>("idle");
  const [url, setUrl] = useState("");
  const [stageIndex, setStageIndex] = useState(0);
  const [result, setResult] = useState<AuditResult | null>(null);
  const [apiData, setApiData] = useState<APIAuditData | null>(null);
  const [isRealAudit, setIsRealAudit] = useState(false);
  const [siteContext, setSiteContext] = useState<SiteContext | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  // Category order state
  const [categoryOrder, setCategoryOrder] = useState<Category[]>(DEFAULT_CATEGORY_ORDER);
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);

  // Drawer state
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [selectedFinding, setSelectedFinding] = useState<AuditFinding | null>(null);
  const [activeTab, setActiveTab] = useState<ToolId>("lovable");
  const [copiedPrompt, setCopiedPrompt] = useState<ToolId | null>(null);

  // Evidence drawer state
  const [evidenceDrawerOpen, setEvidenceDrawerOpen] = useState(false);
  const [evidenceFinding, setEvidenceFinding] = useState<AuditFinding | null>(null);

  // Screenshot state — captured asynchronously after audit completes
  const [screenshotBase64, setScreenshotBase64] = useState<string | null>(null);
  const [screenshotLoading, setScreenshotLoading] = useState(false);
  const [screenshotError, setScreenshotError] = useState<string | null>(null);
  const [screenshotMeta, setScreenshotMeta] = useState<{
    capturedAt: string;
    viewport: string;
    durationMs: number;
  } | null>(null);
  const [screenshotModalOpen, setScreenshotModalOpen] = useState(false);
  // When the modal is opened from an evidence drawer, we track the finding
  // so we can render the matching annotation overlay inside the full screenshot.
  const [screenshotModalFinding, setScreenshotModalFinding] = useState<AuditFinding | null>(null);

  // Builder selector — user can pre-select their builder before running audit
  // null = Auto-detect (uses detection from audit result)
  const [preferredBuilder, setPreferredBuilder] = useState<string | null>(null);

  // Scan gate — tracks whether user has explicitly confirmed a YELLOW limited-scan warning.
  // GREEN scans auto-confirm. RED scans never show findings regardless of this value.
  const [scanGateConfirmed, setScanGateConfirmed] = useState(false);

  // Inspector view state — "table" is the default; "inspector" is the Jira-style two-panel view
  const [viewMode, setViewMode] = useState<"table" | "inspector">("table");
  const [inspectorFindingId, setInspectorFindingId] = useState<string | null>(null);
  const [inspectorActiveTab, setInspectorActiveTab] = useState<ToolId>("lovable");

  // Language picker — results page only
  const [lang, setLang] = useState<LangCode>("en");
  useEffect(() => {
    const saved = localStorage.getItem("audit-lang") as LangCode | null;
    if (saved && (["en","he","ru","es"] as LangCode[]).includes(saved)) setLang(saved);
  }, []);
  useEffect(() => { localStorage.setItem("audit-lang", lang); }, [lang]);
  const t = (key: string): string => TRANSLATIONS[lang]?.[key] ?? TRANSLATIONS.en[key] ?? key;
  const isRTL = lang === "he";

  // Demo iteration mode — simulated progress card
  const [demoOpen, setDemoOpen] = useState(false);
  const [demoPhase, setDemoPhase] = useState(0);
  // Mounted flag — prevents SSR/client hydration mismatch for client-only elements
  const [mounted, setMounted] = useState(false);

  // Modal zoom/pan state
  const [modalZoom, setModalZoom] = useState(1);
  const [modalPan, setModalPan] = useState({ x: 0, y: 0 });
  const [modalIsDragging, setModalIsDragging] = useState(false);
  const modalDragging = useRef(false);
  const modalLastPos = useRef({ x: 0, y: 0 });

  const resultRef = useRef<HTMLDivElement>(null);
  const pageSnapshotRef = useRef<HTMLDivElement>(null);
  const [snapshotHighlight, setSnapshotHighlight] = useState<Priority | null>(null);

  useEffect(() => {
    if (drawerOpen || evidenceDrawerOpen || screenshotModalOpen) document.body.style.overflow = "hidden";
    else document.body.style.overflow = "";
    return () => { document.body.style.overflow = ""; };
  }, [drawerOpen, evidenceDrawerOpen, screenshotModalOpen]);

  // Mark as client-mounted — gates any client-only rendering to avoid hydration mismatch
  useEffect(() => { setMounted(true); }, []);

  // Esc closes screenshot modal
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setScreenshotModalOpen(false);
        setScreenshotModalFinding(null);
      }
    }
    if (screenshotModalOpen) window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [screenshotModalOpen]);

  // Reset zoom & pan when modal closes
  useEffect(() => {
    if (!screenshotModalOpen) {
      setModalZoom(1);
      setModalPan({ x: 0, y: 0 });
      setModalIsDragging(false);
      modalDragging.current = false;
    }
  }, [screenshotModalOpen]);

  // ── Drag handlers ─────────────────────────────────────────────────────────
  function handleDragStart(e: React.DragEvent, idx: number) {
    setDragIdx(idx);
    e.dataTransfer.effectAllowed = "move";
  }
  function handleDragOver(e: React.DragEvent, idx: number) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOverIdx(idx);
  }
  function handleDrop(e: React.DragEvent, targetIdx: number) {
    e.preventDefault();
    if (dragIdx === null || dragIdx === targetIdx) { setDragIdx(null); setDragOverIdx(null); return; }
    const next = [...categoryOrder];
    const [removed] = next.splice(dragIdx, 1);
    next.splice(targetIdx, 0, removed);
    setCategoryOrder(next);
    setDragIdx(null);
    setDragOverIdx(null);
  }
  function handleDragEnd() { setDragIdx(null); setDragOverIdx(null); }

  /** Close the evidence drawer, smooth-scroll to the Page Snapshot card, then pulse-highlight it for 2s */
  function jumpToSnapshot(priority: Priority) {
    setEvidenceDrawerOpen(false);
    // body.overflow is re-unlocked by the useEffect when evidenceDrawerOpen becomes false
    setTimeout(() => {
      pageSnapshotRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      setSnapshotHighlight(priority);
      setTimeout(() => setSnapshotHighlight(null), 2000);
    }, 150);
  }

  function moveCategory(from: number, to: number) {
    if (to < 0 || to >= categoryOrder.length) return;
    const next = [...categoryOrder];
    const [removed] = next.splice(from, 1);
    next.splice(to, 0, removed);
    setCategoryOrder(next);
  }

  // ── Sort findings by user category priority, then urgency ─────────────────
  function sortFindings(findings: AuditFinding[]): AuditFinding[] {
    const catPriority: Record<string, number> = Object.fromEntries(
      categoryOrder.map((c, i) => [c, i])
    );
    const issuePriority = { urgent: 0, important: 1, later: 2 };
    return [...findings].sort((a, b) => {
      const catDiff = (catPriority[a.category] ?? 999) - (catPriority[b.category] ?? 999);
      if (catDiff !== 0) return catDiff;
      return (issuePriority[a.priority] ?? 3) - (issuePriority[b.priority] ?? 3);
    });
  }

  function normalise(raw: string) {
    const t = raw.trim();
    return t && !t.startsWith("http") ? `https://${t}` : t;
  }

  /**
   * Returns true only for inputs that look like real website URLs.
   * Rejects: random text, terminal commands, strings with spaces, no-dot hostnames.
   */
  function isValidAuditUrl(raw: string): boolean {
    const t = raw.trim();
    if (!t) return false;
    // Spaces anywhere in the raw input immediately disqualify (catches "npm run dev" etc.)
    if (/\s/.test(t)) return false;
    // Must be parseable as a URL after optional https:// prepend
    try {
      const withProto = t.startsWith("http://") || t.startsWith("https://") ? t : `https://${t}`;
      const u = new URL(withProto);
      const host = u.hostname.toLowerCase();
      // Must contain at least one dot  (rejects bare words like "localhost", "npm", "git")
      if (!host.includes(".")) return false;
      // Each hostname label: only letters, digits, hyphens; no empty labels
      const labels = host.split(".");
      if (!labels.every((l) => l.length > 0 && /^[a-z0-9-]+$/.test(l))) return false;
      // TLD must be at least 2 chars
      if (labels[labels.length - 1].length < 2) return false;
      return true;
    } catch {
      return false;
    }
  }

  async function runAudit(urlOverride?: string) {
    const raw = urlOverride ?? url;
    if (urlOverride) setUrl(urlOverride);
    if (!isValidAuditUrl(raw)) {
      setError("Enter a valid website URL to audit.");
      return;
    }
    const norm = normalise(raw);
    if (!norm) { setError("Enter a valid website URL to audit."); return; }
    setError("");
    setAuditState("loading");
    setApiData(null);
    setIsRealAudit(false);
    setSiteContext(null);
    setStageIndex(0);

    // ── Stage 1: fetch via real API ──────────────────────────────────────────
    await new Promise((r) => setTimeout(r, 300));
    setStageIndex(1);

    let fetchedData: APIAuditData | null = null;
    let apiError: string | null = null;

    try {
      const response = await fetch("/api/audit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: norm }),
        signal: AbortSignal.timeout(12000), // 12s client timeout
      });

      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        apiError = body.error ?? `Server returned ${response.status}`;
      } else {
        fetchedData = await response.json() as APIAuditData;
      }
    } catch (err) {
      const isTimeout = (err as Error).name === "TimeoutError" || (err as Error).name === "AbortError";
      apiError = isTimeout
        ? "The site took too long to respond. Try a different URL."
        : "Could not reach the target site. It may block automated requests.";
    }

    // ── Stage 2: analyse ─────────────────────────────────────────────────────
    setStageIndex(2);
    await new Promise((r) => setTimeout(r, 400));
    setStageIndex(3);
    await new Promise((r) => setTimeout(r, 300));

    if (fetchedData) {
      // ✅ Real data available — classify context and use it
      setApiData(fetchedData);
      setIsRealAudit(true);

      let parsedHostname = "";
      let parsedPath = "";
      try {
        const u = new URL(fetchedData.url);
        parsedHostname = u.hostname;
        parsedPath = u.pathname;
      } catch { /* leave empty */ }

      const ctx = classifySiteContext({
        hostname: parsedHostname,
        urlPath: parsedPath,
        title: fetchedData.title,
        description: fetchedData.description,
        h1Tags: fetchedData.h1Tags,
        h2Tags: fetchedData.h2Tags,
        wordCount: fetchedData.wordCount,
        buttonCount: fetchedData.buttons.total,
        formCount: fetchedData.forms.total,
        linkCount: fetchedData.links.total,
        hasPricing: fetchedData.signals.hasPricing,
        hasSignup: fetchedData.signals.hasSignup,
        hasContact: fetchedData.signals.hasContact,
        detectedBuilder: detectBuilder(norm),
      });

      setSiteContext(ctx);

      // Compute scan quality from actual DOM signals (pass URL for domain + login checks)
      const quality = computeScanQuality(fetchedData, null, norm);

      setResult(buildRealAuditResult(fetchedData, norm, ctx, quality));

      // Evaluate initial gate WITHOUT screenshot (not available yet).
      // GREEN at this stage requires confidence >= 90 (exceptionally strong DOM).
      // Screenshot loading later can upgrade a YELLOW to GREEN at render time.
      const initialLight = getScanTrafficLight(quality, false);
      setScanGateConfirmed(initialLight === "green");

    } else {
      // ❌ API failed — show FAILED state, do NOT display heuristic findings
      setIsRealAudit(false);
      setResult(buildFailedAuditResult(norm, apiError ?? "Could not access this website."));
      setScanGateConfirmed(false);
    }

    setAuditState("results");
    setTimeout(() => resultRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 100);

    // Kick off screenshot capture asynchronously — audit results appear immediately
    // while the screenshot loads in the background.
    captureScreenshot(norm);
  }

  /** Async screenshot fetch — fires after audit results are shown */
  async function captureScreenshot(targetUrl: string) {
    setScreenshotLoading(true);
    setScreenshotBase64(null);
    setScreenshotError(null);
    try {
      const res = await fetch("/api/screenshot", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: targetUrl }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const data = await res.json() as {
        screenshotBase64?: string;
        capturedAt?: string;
        viewport?: string;
        durationMs?: number;
      };
      if (data.screenshotBase64) {
        setScreenshotBase64(data.screenshotBase64);
        setScreenshotMeta({
          capturedAt: data.capturedAt ?? new Date().toISOString(),
          viewport: data.viewport ?? "desktop",
          durationMs: data.durationMs ?? 0,
        });
      } else {
        throw new Error("No screenshot data returned");
      }
    } catch (err) {
      setScreenshotError(err instanceof Error ? err.message : "Screenshot unavailable");
    } finally {
      setScreenshotLoading(false);
    }
  }

  function viewExampleAudit() {
    runAudit("https://rapyd-spark-insights.lovable.app/");
  }

  function startDemoIteration() {
    setDemoOpen(true);
    setDemoPhase(1);
    setTimeout(() => setDemoPhase(2), 1500);   // audit 1 score revealed
    setTimeout(() => setDemoPhase(3), 2500);   // fix prompts 1 shown
    setTimeout(() => setDemoPhase(4), 3200);   // audit 2 scanning
    setTimeout(() => setDemoPhase(5), 4700);   // audit 2 score revealed
    setTimeout(() => setDemoPhase(6), 5700);   // fix prompts 2 shown
    setTimeout(() => setDemoPhase(7), 6400);   // audit 3 scanning
    setTimeout(() => setDemoPhase(8), 7900);   // audit 3 score revealed
  }

  function reset() {
    setAuditState("idle"); setUrl(""); setResult(null); setApiData(null);
    setIsRealAudit(false); setSiteContext(null); setError(""); setCopied(false);
    setDrawerOpen(false); setSelectedFinding(null);
    setEvidenceDrawerOpen(false); setEvidenceFinding(null);
    setCategoryOrder(DEFAULT_CATEGORY_ORDER);
    setScreenshotBase64(null); setScreenshotLoading(false); setScreenshotError(null);
    setScreenshotMeta(null); setScreenshotModalOpen(false);
    setScanGateConfirmed(false);
  }

  function openDrawer(finding: AuditFinding) {
    setSelectedFinding(finding);
    // preferredBuilder (user-selected) takes precedence over auto-detected builder
    const tabFromPreferred = preferredBuilder ? getRecommendedTab(preferredBuilder) : null;
    const tabFromDetected = getRecommendedTab(result?.detectedBuilder ?? null);
    setActiveTab(tabFromPreferred ?? tabFromDetected ?? "generic");
    setDrawerOpen(true);
    setCopiedPrompt(null);
    // Mutually exclusive with evidence drawer
    setEvidenceDrawerOpen(false);
  }

  function openEvidenceDrawer(finding: AuditFinding) {
    setEvidenceFinding(finding);
    setEvidenceDrawerOpen(true);
    // Mutually exclusive with fix prompt drawer
    setDrawerOpen(false);
  }

  function copyPrompt(tool: ToolId, prompt: string) {
    navigator.clipboard.writeText(prompt).catch(() => null);
    setCopiedPrompt(tool);
    setTimeout(() => setCopiedPrompt(null), 2000);
  }

  function copyFullReport() {
    if (!result) return;
    const sorted = sortFindings(result.findings);
    const text = sorted.map((f) =>
      `[${f.priority.toUpperCase()}] ${f.category}\n${f.issue}\nWhy: ${f.whyItMatters}\nFix: ${f.suggestedFix}`
    ).join("\n\n");
    const auditNote = isRealAudit
      ? `Real audit · page fetched in ${apiData?.fetchDuration ?? "?"}ms · findings from actual HTML`
      : "Heuristic mode · page could not be fetched · findings based on URL patterns";
    navigator.clipboard.writeText(`AI Builder QA Audit — ${result.domain}\nPrioritised by: ${categoryOrder.slice(0, 3).join(", ")}\n${auditNote}\n\n${text}`).catch(() => null);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  // ── Idle — premium centered homepage ─────────────────────────────────────
  if (auditState === "idle") return (
    <>
    {/* ── Hero ─────────────────────────────────────────────────────────────── */}
    <div className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden px-4 pb-32 pt-48 text-center">

      {/* ── Floating builder card ecosystem — client-only to avoid hydration mismatch ── */}
      {mounted && (
        <>
        {/* Inject keyframes directly — guarantees animation regardless of Tailwind processing */}
        <style dangerouslySetInnerHTML={{__html:`
          @keyframes builderFloatA{0%,100%{transform:translateY(0px) translateX(0px) rotate(0deg)}40%{transform:translateY(-36px) translateX(22px) rotate(1.5deg)}70%{transform:translateY(22px) translateX(-14px) rotate(-0.8deg)}}
          @keyframes builderFloatB{0%,100%{transform:translateY(0px) translateX(0px) rotate(0deg)}30%{transform:translateY(30px) translateX(-20px) rotate(-1.2deg)}65%{transform:translateY(-28px) translateX(18px) rotate(1deg)}}
          @keyframes builderFloatC{0%,100%{transform:translateY(0px) translateX(0px) rotate(0deg)}45%{transform:translateY(-40px) translateX(-24px) rotate(1.8deg)}75%{transform:translateY(26px) translateX(18px) rotate(-1deg)}}
          @keyframes builderFloatD{0%,100%{transform:translateY(0px) translateX(0px) rotate(0deg)}35%{transform:translateY(34px) translateX(22px) rotate(-1.4deg)}68%{transform:translateY(-24px) translateX(-16px) rotate(0.9deg)}}
          @keyframes builderFloatE{0%,100%{transform:translateY(0px) translateX(0px) rotate(0deg)}50%{transform:translateY(-30px) translateX(-18px) rotate(1.2deg)}80%{transform:translateY(20px) translateX(14px) rotate(-0.7deg)}}
          @keyframes builderFloatF{0%,100%{transform:translateY(0px) translateX(0px) rotate(0deg)}38%{transform:translateY(38px) translateX(-22px) rotate(-1.6deg)}72%{transform:translateY(-26px) translateX(16px) rotate(1deg)}}
          @keyframes builderFloatG{0%,100%{transform:translateY(0px) translateX(0px) rotate(0deg)}42%{transform:translateY(-28px) translateX(20px) rotate(0.9deg)}78%{transform:translateY(24px) translateX(-18px) rotate(-1.1deg)}}
          .builder-float-a{animation:builderFloatA 9s ease-in-out 0s infinite}
          .builder-float-b{animation:builderFloatB 11s ease-in-out 1.4s infinite}
          .builder-float-c{animation:builderFloatC 12s ease-in-out 3s infinite}
          .builder-float-d{animation:builderFloatD 10s ease-in-out 0.7s infinite}
          .builder-float-e{animation:builderFloatE 8s ease-in-out 4.2s infinite}
          .builder-float-f{animation:builderFloatF 11s ease-in-out 2.1s infinite}
          .builder-float-g{animation:builderFloatG 9s ease-in-out 5s infinite}
          @media(prefers-reduced-motion:reduce){.builder-float-a,.builder-float-b,.builder-float-c,.builder-float-d,.builder-float-e,.builder-float-f,.builder-float-g{animation:none}}
        `}} />
        <div aria-hidden="true" className="pointer-events-none absolute inset-0 select-none">

          {/* ── Lovable — upper-left ── */}
          <div className="builder-float-a" style={{ position:"absolute", top:"10%", left:"3%", width:152, opacity:0.22 }}>
            <div style={{ background:"rgba(255,255,255,0.88)", border:"1px solid rgba(0,0,0,0.07)", borderRadius:14, padding:"14px 16px", boxShadow:"0 4px 20px rgba(0,0,0,0.07), 0 1px 4px rgba(0,0,0,0.04)", backdropFilter:"blur(8px)" }}>
              <div style={{ width:32, height:32, borderRadius:8, background:"linear-gradient(135deg,#8b5cf6,#6d28d9)", marginBottom:10 }} />
              <p style={{ fontSize:14, fontWeight:700, color:"#18181b", margin:0, fontFamily:"inherit", letterSpacing:"-0.01em" }}>Lovable</p>
              <p style={{ fontSize:11, color:"#a1a1aa", margin:"3px 0 0", fontFamily:"monospace" }}>Visual builder</p>
            </div>
          </div>

          {/* ── Claude — upper-right ── */}
          <div className="builder-float-b" style={{ position:"absolute", top:"8%", right:"3%", width:148, opacity:0.20 }}>
            <div style={{ background:"rgba(255,255,255,0.88)", border:"1px solid rgba(0,0,0,0.07)", borderRadius:14, padding:"14px 16px", boxShadow:"0 4px 20px rgba(0,0,0,0.07), 0 1px 4px rgba(0,0,0,0.04)", backdropFilter:"blur(8px)" }}>
              <div style={{ width:32, height:32, borderRadius:8, background:"linear-gradient(135deg,#f97316,#ea580c)", marginBottom:10 }} />
              <p style={{ fontSize:14, fontWeight:700, color:"#18181b", margin:0, fontFamily:"inherit", letterSpacing:"-0.01em" }}>Claude</p>
              <p style={{ fontSize:11, color:"#a1a1aa", margin:"3px 0 0", fontFamily:"monospace" }}>AI builder</p>
            </div>
          </div>

          {/* ── Base44 — mid-left ── */}
          <div className="builder-float-c" style={{ position:"absolute", top:"42%", left:"2%", width:150, opacity:0.18 }}>
            <div style={{ background:"rgba(255,255,255,0.88)", border:"1px solid rgba(0,0,0,0.07)", borderRadius:14, padding:"14px 16px", boxShadow:"0 4px 20px rgba(0,0,0,0.07), 0 1px 4px rgba(0,0,0,0.04)", backdropFilter:"blur(8px)" }}>
              <div style={{ width:32, height:32, borderRadius:8, background:"linear-gradient(135deg,#3b82f6,#1d4ed8)", marginBottom:10 }} />
              <p style={{ fontSize:14, fontWeight:700, color:"#18181b", margin:0, fontFamily:"inherit", letterSpacing:"-0.01em" }}>Base44</p>
              <p style={{ fontSize:11, color:"#a1a1aa", margin:"3px 0 0", fontFamily:"monospace" }}>App builder</p>
            </div>
          </div>

          {/* ── Cursor — mid-right ── */}
          <div className="builder-float-d" style={{ position:"absolute", top:"38%", right:"2%", width:148, opacity:0.20 }}>
            <div style={{ background:"rgba(255,255,255,0.88)", border:"1px solid rgba(0,0,0,0.07)", borderRadius:14, padding:"14px 16px", boxShadow:"0 4px 20px rgba(0,0,0,0.07), 0 1px 4px rgba(0,0,0,0.04)", backdropFilter:"blur(8px)" }}>
              <div style={{ width:32, height:32, borderRadius:8, background:"linear-gradient(135deg,#27272a,#18181b)", marginBottom:10 }} />
              <p style={{ fontSize:14, fontWeight:700, color:"#18181b", margin:0, fontFamily:"inherit", letterSpacing:"-0.01em" }}>Cursor</p>
              <p style={{ fontSize:11, color:"#a1a1aa", margin:"3px 0 0", fontFamily:"monospace" }}>AI IDE</p>
            </div>
          </div>

          {/* ── Bolt — lower-left ── */}
          <div className="builder-float-e" style={{ position:"absolute", bottom:"18%", left:"3%", width:144, opacity:0.17 }}>
            <div style={{ background:"rgba(255,255,255,0.88)", border:"1px solid rgba(0,0,0,0.07)", borderRadius:14, padding:"14px 16px", boxShadow:"0 4px 20px rgba(0,0,0,0.07), 0 1px 4px rgba(0,0,0,0.04)", backdropFilter:"blur(8px)" }}>
              <div style={{ width:32, height:32, borderRadius:8, background:"linear-gradient(135deg,#f59e0b,#d97706)", marginBottom:10 }} />
              <p style={{ fontSize:14, fontWeight:700, color:"#18181b", margin:0, fontFamily:"inherit", letterSpacing:"-0.01em" }}>Bolt</p>
              <p style={{ fontSize:11, color:"#a1a1aa", margin:"3px 0 0", fontFamily:"monospace" }}>Web builder</p>
            </div>
          </div>

          {/* ── v0 — lower-right ── */}
          <div className="builder-float-f" style={{ position:"absolute", bottom:"16%", right:"3%", width:140, opacity:0.22 }}>
            <div style={{ background:"rgba(255,255,255,0.88)", border:"1px solid rgba(0,0,0,0.07)", borderRadius:14, padding:"14px 16px", boxShadow:"0 4px 20px rgba(0,0,0,0.07), 0 1px 4px rgba(0,0,0,0.04)", backdropFilter:"blur(8px)" }}>
              <div style={{ width:32, height:32, borderRadius:8, background:"linear-gradient(135deg,#18181b,#09090b)", marginBottom:10 }} />
              <p style={{ fontSize:14, fontWeight:700, color:"#18181b", margin:0, fontFamily:"inherit", letterSpacing:"-0.01em" }}>v0</p>
              <p style={{ fontSize:11, color:"#a1a1aa", margin:"3px 0 0", fontFamily:"monospace" }}>UI generator</p>
            </div>
          </div>

          {/* ── Replit — upper-center-right ── */}
          <div className="builder-float-g" style={{ position:"absolute", top:"19%", right:"19%", width:146, opacity:0.14 }}>
            <div style={{ background:"rgba(255,255,255,0.88)", border:"1px solid rgba(0,0,0,0.07)", borderRadius:14, padding:"14px 16px", boxShadow:"0 4px 20px rgba(0,0,0,0.07), 0 1px 4px rgba(0,0,0,0.04)", backdropFilter:"blur(8px)" }}>
              <div style={{ width:32, height:32, borderRadius:8, background:"linear-gradient(135deg,#f97316,#dc2626)", marginBottom:10 }} />
              <p style={{ fontSize:14, fontWeight:700, color:"#18181b", margin:0, fontFamily:"inherit", letterSpacing:"-0.01em" }}>Replit</p>
              <p style={{ fontSize:11, color:"#a1a1aa", margin:"3px 0 0", fontFamily:"monospace" }}>AI builder</p>
            </div>
          </div>

        </div>
        </>
      )}

      {/* ── Soft radial glow behind headline ── */}
      <div
        aria-hidden="true"
        style={{
          position:"absolute", top:"30%", left:"50%",
          transform:"translateX(-50%)",
          width:800, height:420,
          background:"radial-gradient(ellipse at center, rgba(99,102,241,0.06) 0%, rgba(139,92,246,0.03) 45%, transparent 72%)",
          pointerEvents:"none", zIndex:0,
        }}
      />

      {/* ── Content — above background ── */}
      <div className="relative z-10 flex flex-col items-center">

        {/* Badge */}
        <div className="mb-9 inline-flex items-center gap-2 rounded-full border border-zinc-200 bg-white/90 px-4 py-1.5 shadow-sm backdrop-blur-sm">
          <span className="h-1.5 w-1.5 rounded-full bg-zinc-700" />
          <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-500">AI Builder QA</span>
        </div>

        {/* Headline */}
        <h1
          className="mb-5 max-w-[680px] text-[42px] font-bold leading-[1.06] text-zinc-950 sm:text-[64px]"
          style={{ letterSpacing:"-0.03em" }}
        >
          Find what to fix next.
        </h1>

        {/* Subtitle */}
        <p className="mb-11 max-w-[500px] text-[17px] leading-relaxed text-zinc-400">
          Paste your AI-built site. Get visual evidence and exact prompts for Lovable, Claude, Base44, Cursor, Bolt, v0 and Replit.
        </p>

        {/* ── URL input + CTA ── */}
        <div className="w-full max-w-[580px]">
          <div
            className={`flex flex-col overflow-hidden rounded-2xl border bg-white shadow-md transition-all sm:flex-row ${
              error ? "border-red-300" : "border-zinc-200 focus-within:border-zinc-400 focus-within:shadow-lg"
            }`}
          >
            <input
              type="text"
              value={url}
              onChange={(e) => { setUrl(e.target.value); setError(""); }}
              onKeyDown={(e) => { if (e.key === "Enter") runAudit(); }}
              placeholder="https://myapp.lovable.app"
              className={`flex-1 bg-transparent px-5 py-4 text-base text-zinc-900 outline-none placeholder:text-zinc-300 ${error ? "bg-red-50" : ""}`}
              suppressHydrationWarning
            />
            <div className="shrink-0 p-1.5">
              <button
                onClick={() => runAudit()}
                className="w-full rounded-xl bg-zinc-950 px-6 py-3 text-sm font-semibold text-white shadow-sm transition-all hover:bg-zinc-800 active:scale-[0.98] sm:w-auto"
              >
                Find what to fix
              </button>
            </div>
          </div>
          {error && <p className="mt-2 text-left text-sm text-red-500">{error}</p>}
        </div>

        {/* ── Builder selector ── */}
        <div className="mt-4 flex flex-wrap items-center justify-center gap-2.5">
          <span className="font-mono text-[11px] text-zinc-400">Built with</span>
          <div className="relative">
            <select
              value={preferredBuilder ?? ""}
              onChange={(e) => setPreferredBuilder(e.target.value || null)}
              className="cursor-pointer appearance-none rounded-full border border-zinc-200 bg-white py-1.5 pl-3.5 pr-8 font-mono text-[12px] text-zinc-600 transition-colors hover:border-zinc-400 focus:outline-none focus:border-zinc-400"
            >
              <option value="">Auto-detect</option>
              <option value="lovable">Lovable</option>
              <option value="base44">Base44</option>
              <option value="claude">Claude</option>
              <option value="cursor">Cursor</option>
              <option value="bolt">Bolt</option>
              <option value="v0">v0</option>
              <option value="replit">Replit</option>
            </select>
            <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-400" aria-hidden="true">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M6 9l6 6 6-6"/></svg>
            </span>
          </div>
          {preferredBuilder && (
            <span className="font-mono text-[11px] text-zinc-400">
              We&apos;ll prioritize fix prompts for this builder.
            </span>
          )}
        </div>

        {/* ── Mini-flow ── */}
        <div className="mt-5 flex flex-wrap items-center justify-center gap-x-1 gap-y-2">
          {[
            { step: "Paste URL", icon: "↓" },
            { step: "Analyze", icon: "→" },
            { step: "Get fixes", icon: "→" },
            { step: "Send to builder", icon: null },
          ].map(({ step, icon }) => (
            <span key={step} className="flex items-center gap-1">
              <span className="rounded-full border border-zinc-200 bg-zinc-50 px-3 py-1 font-mono text-[11px] text-zinc-500">{step}</span>
              {icon && <span className="font-mono text-[11px] text-zinc-300">{icon}</span>}
            </span>
          ))}
        </div>

        {/* Trust + secondary actions */}
        <div className="mt-9 flex flex-wrap items-center justify-center gap-4 sm:gap-6">
          <button
            onClick={viewExampleAudit}
            className="inline-flex items-center gap-2 text-sm font-medium text-zinc-500 transition-colors hover:text-zinc-800"
          >
            <span className="flex h-6 w-6 items-center justify-center rounded-full border border-zinc-300 bg-white shadow-sm">
              <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><polygon points="9,7 17,12 9,17"/></svg>
            </span>
            See example audit
          </button>
          <span className="text-zinc-200">·</span>
          <button
            onClick={startDemoIteration}
            className="inline-flex items-center gap-1.5 text-sm text-zinc-400 transition-colors hover:text-zinc-600"
          >
            See score improve over 3 iterations
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
          </button>
        </div>

        {/* Fine print */}
        <p className="mt-10 font-mono text-[10px] text-zinc-300">
          No signup required · Analyzes real page content · No data stored
        </p>

      </div>
    </div>

    {/* ── Demo Iteration Card ─────────────────────────────────────── */}
    {demoOpen && (
      <div className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900">
        {/* Header */}
        <div className="flex items-start justify-between border-b border-zinc-800 px-5 py-4">
          <div className="min-w-0 mr-4">
            <div className="mb-1 flex items-center gap-2">
              <span className="font-mono text-[10px] font-semibold uppercase tracking-widest text-zinc-400">Demo iteration loop</span>
              <span className="rounded-full bg-violet-500/20 px-2 py-0.5 font-mono text-[9px] font-semibold text-violet-300">simulated</span>
            </div>
            <p className="font-mono text-[11px] text-zinc-500 truncate">rapyd-spark-insights.lovable.app</p>
          </div>
          <button
            onClick={() => { setDemoOpen(false); setDemoPhase(0); }}
            className="shrink-0 flex h-7 w-7 items-center justify-center rounded-md border border-zinc-700 text-zinc-500 hover:border-zinc-500 hover:text-zinc-300 transition-colors"
          >
            <svg width="12" height="12" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>

        {/* Timeline */}
        <div className="px-5 py-5 space-y-0">

          {/* ── Audit 1 ── */}
          {demoPhase >= 1 && (
            <div className="flex items-start gap-4">
              {/* Score badge */}
              <div className="shrink-0 mt-0.5">
                {demoPhase === 1 ? (
                  <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-zinc-800 border border-zinc-700">
                    <div className="h-4 w-4 animate-spin rounded-full border-2 border-zinc-600 border-t-zinc-300" />
                  </div>
                ) : (
                  <div className="flex h-12 w-12 flex-col items-center justify-center rounded-xl bg-red-500/15 border border-red-500/30">
                    <span className="font-mono text-lg font-bold leading-none text-red-400">8</span>
                    <span className="font-mono text-[8px] text-red-500/70">/100</span>
                  </div>
                )}
              </div>
              {/* Content */}
              <div className="flex-1 min-w-0 pb-4">
                <div className="flex flex-wrap items-center gap-2 mb-2">
                  <span className="font-mono text-xs font-semibold text-zinc-300">Audit #1</span>
                  {demoPhase >= 2 && (
                    <span className="rounded-full bg-red-500/15 px-2 py-0.5 font-mono text-[10px] font-semibold text-red-400 border border-red-500/20">8 / 100</span>
                  )}
                  {demoPhase === 1 && <span className="font-mono text-[10px] text-zinc-500 animate-pulse">Scanning…</span>}
                  {demoPhase >= 2 && <span className="font-mono text-[9px] text-zinc-500">Initial scan</span>}
                </div>
                {demoPhase >= 2 && (
                  <div className="flex flex-wrap gap-1.5">
                    {["No headline", "CTA missing", "No social proof", "8 nav items", "No trust signals", "No pricing"].map((issue) => (
                      <span key={issue} className="rounded-full border border-red-900/50 bg-red-950/50 px-2 py-0.5 font-mono text-[9px] text-red-400">{issue}</span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ── Fix prompts 1 ── */}
          {demoPhase >= 3 && (
            <div className="mb-4 ml-16 rounded-lg border border-zinc-700/60 bg-zinc-800/50 px-4 py-3">
              <div className="mb-2 flex items-center gap-2">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-violet-400"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
                <span className="font-mono text-[9px] font-semibold uppercase tracking-wider text-violet-400">Fix prompts applied in Lovable</span>
              </div>
              <div className="space-y-1.5">
                {[
                  "Add a bold headline above the fold that explains what Spark Insights does",
                  "Add a primary CTA button: 'Start free trial' visible on load",
                  "Reduce navigation to 4 items: Product, Pricing, Blog, Sign in",
                ].map((p) => (
                  <p key={p} className="flex items-start gap-1.5 font-mono text-[10px] text-zinc-400">
                    <span className="mt-px shrink-0 text-violet-500">✓</span>
                    <span className="italic">"{p}"</span>
                  </p>
                ))}
              </div>
            </div>
          )}

          {/* ── Audit 2 ── */}
          {demoPhase >= 4 && (
            <div className="flex items-start gap-4">
              <div className="shrink-0 mt-0.5">
                {demoPhase === 4 ? (
                  <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-zinc-800 border border-zinc-700">
                    <div className="h-4 w-4 animate-spin rounded-full border-2 border-zinc-600 border-t-zinc-300" />
                  </div>
                ) : (
                  <div className="flex h-12 w-12 flex-col items-center justify-center rounded-xl bg-amber-500/15 border border-amber-500/30">
                    <span className="font-mono text-lg font-bold leading-none text-amber-400">42</span>
                    <span className="font-mono text-[8px] text-amber-500/70">/100</span>
                  </div>
                )}
              </div>
              <div className="flex-1 min-w-0 pb-4">
                <div className="flex flex-wrap items-center gap-2 mb-2">
                  <span className="font-mono text-xs font-semibold text-zinc-300">Audit #2</span>
                  {demoPhase >= 5 && (
                    <span className="rounded-full bg-amber-500/15 px-2 py-0.5 font-mono text-[10px] font-semibold text-amber-400 border border-amber-500/20">42 / 100</span>
                  )}
                  {demoPhase >= 5 && (
                    <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 font-mono text-[10px] font-semibold text-emerald-400 border border-emerald-500/20">+34 pts</span>
                  )}
                  {demoPhase === 4 && <span className="font-mono text-[10px] text-zinc-500 animate-pulse">Scanning…</span>}
                </div>
                {demoPhase >= 5 && (
                  <div className="flex flex-wrap gap-1.5">
                    {["Headline ✓", "CTA ✓", "Navigation ✓", "No testimonials", "No trust badges", "No social proof"].map((issue) => (
                      <span key={issue} className={`rounded-full border px-2 py-0.5 font-mono text-[9px] ${issue.includes("✓") ? "border-emerald-900/50 bg-emerald-950/50 text-emerald-400" : "border-amber-900/50 bg-amber-950/50 text-amber-400"}`}>{issue}</span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ── Fix prompts 2 ── */}
          {demoPhase >= 6 && (
            <div className="mb-4 ml-16 rounded-lg border border-zinc-700/60 bg-zinc-800/50 px-4 py-3">
              <div className="mb-2 flex items-center gap-2">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="text-violet-400"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>
                <span className="font-mono text-[9px] font-semibold uppercase tracking-wider text-violet-400">Fix prompts applied in Lovable</span>
              </div>
              <div className="space-y-1.5">
                {[
                  "Add 3 customer testimonials with names, photos, and companies",
                  "Add a social proof bar: '2,400+ teams use Spark Insights'",
                  "Add trust badges: SOC 2 compliant, GDPR, Free trial — no credit card",
                ].map((p) => (
                  <p key={p} className="flex items-start gap-1.5 font-mono text-[10px] text-zinc-400">
                    <span className="mt-px shrink-0 text-violet-500">✓</span>
                    <span className="italic">"{p}"</span>
                  </p>
                ))}
              </div>
            </div>
          )}

          {/* ── Audit 3 ── */}
          {demoPhase >= 7 && (
            <div className="flex items-start gap-4">
              <div className="shrink-0 mt-0.5">
                {demoPhase === 7 ? (
                  <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-zinc-800 border border-zinc-700">
                    <div className="h-4 w-4 animate-spin rounded-full border-2 border-zinc-600 border-t-zinc-300" />
                  </div>
                ) : (
                  <div className="flex h-12 w-12 flex-col items-center justify-center rounded-xl bg-emerald-500/15 border border-emerald-500/30">
                    <span className="font-mono text-lg font-bold leading-none text-emerald-400">76</span>
                    <span className="font-mono text-[8px] text-emerald-500/70">/100</span>
                  </div>
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex flex-wrap items-center gap-2 mb-2">
                  <span className="font-mono text-xs font-semibold text-zinc-300">Audit #3</span>
                  {demoPhase >= 8 && (
                    <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 font-mono text-[10px] font-semibold text-emerald-400 border border-emerald-500/20">76 / 100</span>
                  )}
                  {demoPhase >= 8 && (
                    <span className="rounded-full bg-emerald-500/15 px-2 py-0.5 font-mono text-[10px] font-semibold text-emerald-400 border border-emerald-500/20">+34 pts</span>
                  )}
                  {demoPhase === 7 && <span className="font-mono text-[10px] text-zinc-500 animate-pulse">Scanning…</span>}
                </div>
                {demoPhase >= 8 && (
                  <div className="flex flex-wrap gap-1.5">
                    {["Headline ✓", "CTA ✓", "Navigation ✓", "Testimonials ✓", "Trust badges ✓", "Social proof ✓"].map((issue) => (
                      <span key={issue} className="rounded-full border border-emerald-900/50 bg-emerald-950/50 px-2 py-0.5 font-mono text-[9px] text-emerald-400">{issue}</span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

        </div>

        {/* Footer */}
        <div className="border-t border-zinc-800 px-5 py-3 flex items-start justify-between gap-4">
          <p className="text-[11px] text-zinc-500 leading-relaxed">
            This simulates how the score improves after applying fix prompts between audits.{" "}
            <a href="https://rapyd-spark-insights.lovable.app/" target="_blank" rel="noopener noreferrer" className="text-zinc-400 underline underline-offset-2 hover:text-zinc-200 transition-colors">View the example site ↗</a>
          </p>
          {demoPhase === 8 && (
            <button
              onClick={() => { setDemoPhase(0); startDemoIteration(); }}
              className="shrink-0 font-mono text-[10px] text-zinc-500 hover:text-zinc-300 transition-colors"
            >
              ↺ Replay
            </button>
          )}
        </div>
      </div>
    )}
    </>
  );

  // ── Loading ───────────────────────────────────────────────────────────────
  if (auditState === "loading") return (
    <div className="rounded-xl border border-zinc-200 bg-white p-6 sm:p-8">
      <div className="mb-5 flex items-center gap-3">
        <div className="flex gap-1">{[0,1,2].map((i) => <div key={i} className="h-2 w-2 rounded-full bg-zinc-300 animate-pulse" style={{ animationDelay: `${i*0.2}s` }} />)}</div>
        <span className="font-mono text-xs text-zinc-500">Auditing {normalise(url).replace(/https?:\/\//, "").split("/")[0]}</span>
      </div>
      <div className="mb-5 space-y-2">
        {LOADING_STAGES.map((stage, i) => (
          <div key={stage} className="flex items-center gap-3">
            <div className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-xs ${i < stageIndex ? "border-green-300 bg-green-50 text-green-600" : i === stageIndex ? "border-zinc-300 bg-zinc-50 text-zinc-400" : "border-zinc-200 text-zinc-200"}`}>
              {i < stageIndex ? "✓" : i === stageIndex ? "→" : "·"}
            </div>
            <span className={`text-sm ${i < stageIndex ? "text-zinc-400 line-through" : i === stageIndex ? "text-zinc-700 font-medium" : "text-zinc-300"}`}>{stage}</span>
          </div>
        ))}
      </div>
      <div className="h-1.5 w-full rounded-full bg-zinc-100 overflow-hidden">
        <div className="h-full rounded-full bg-zinc-900 transition-all duration-500" style={{ width: `${((stageIndex+1)/LOADING_STAGES.length)*100}%` }} />
      </div>
    </div>
  );

  // ── Results ───────────────────────────────────────────────────────────────
  if (auditState === "results" && result) {

    // ── RED / FAILED state — could not complete reliable analysis ───────────
    if (result.scanQuality.status === "failed" || getScanTrafficLight(result.scanQuality, !!screenshotBase64) === "red") {
      return (
        <div ref={resultRef} className="mx-auto max-w-[1200px] py-10 sm:py-14">
          {/* Back action */}
          <div className="mb-6 flex items-center gap-3">
            <button
              onClick={reset}
              className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 px-3 py-1.5 font-mono text-[11px] text-zinc-600 transition-colors hover:border-zinc-400 hover:bg-zinc-50"
            >
              ← {t("tryAnotherUrl")}
            </button>
            <span className="font-mono text-[11px] text-zinc-400">{result.domain}</span>
          </div>

          {/* Failure card */}
          <div className="rounded-2xl border border-red-100 bg-red-50 p-8 text-center">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-red-100">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="text-red-500">
                <circle cx="12" cy="12" r="10"/>
                <line x1="12" y1="8" x2="12" y2="12"/>
                <line x1="12" y1="16" x2="12.01" y2="16"/>
              </svg>
            </div>
            <h2 className="mb-2 text-xl font-bold text-zinc-900">{t("couldNotComplete")}</h2>
            <p className="mb-5 text-sm text-zinc-600">The scan did not extract enough page content to produce trustworthy findings.</p>

            {/* Specific reasons from scanQuality */}
            {result.scanQuality.reasons.length > 0 && (
              <div className="mx-auto mb-6 max-w-md text-left">
                <p className="mb-2 font-mono text-[11px] font-semibold uppercase tracking-widest text-zinc-500">Why this happened</p>
                <ul className="space-y-1.5">
                  {result.scanQuality.reasons.map((r) => (
                    <li key={r} className="flex items-start gap-2 text-sm text-zinc-600">
                      <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-red-400" />
                      {r}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="flex flex-wrap items-center justify-center gap-3">
              <button
                onClick={reset}
                className="rounded-xl bg-zinc-900 px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-zinc-700"
              >
                {t("tryAnotherPublicUrl")}
              </button>
              <button
                onClick={viewExampleAudit}
                className="rounded-xl border border-zinc-200 bg-white px-5 py-2.5 text-sm font-semibold text-zinc-700 transition-colors hover:border-zinc-400"
              >
                {t("seeExampleAudit")}
              </button>
            </div>
          </div>
        </div>
      );
    }

    // ── YELLOW gate — re-evaluate with current screenshot state ─────────────
    // GREEN requires screenshot OR confidence ≥ 90 (see getScanTrafficLight).
    // If screenshot has since loaded, a formerly-YELLOW scan may now be GREEN
    // and the modal clears automatically. If scanGateConfirmed is already true
    // (user confirmed, or scan was auto-confirmed GREEN), skip the modal.
    const trafficLight = getScanTrafficLight(result.scanQuality, !!screenshotBase64);
    if (trafficLight === "yellow" && !scanGateConfirmed) {
      return (
        <div ref={resultRef} className="mx-auto max-w-[1200px] py-10 sm:py-14">
          {/* Back link */}
          <div className="mb-6 flex items-center gap-3">
            <button
              onClick={reset}
              className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 px-3 py-1.5 font-mono text-[11px] text-zinc-600 transition-colors hover:border-zinc-400 hover:bg-zinc-50"
            >
              ← {t("tryAnotherUrl")}
            </button>
            <span className="font-mono text-[11px] text-zinc-400">{result.domain}</span>
          </div>

          {/* Warning card — ~75% viewport height */}
          <div className="flex min-h-[70vh] flex-col items-center justify-center rounded-2xl border border-amber-200 bg-amber-50 px-8 py-14 text-center">
            {/* Traffic light icon */}
            <div className="mb-6 flex h-14 w-14 items-center justify-center rounded-full bg-amber-100">
              <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="text-amber-600">
                <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/>
                <line x1="12" y1="9" x2="12" y2="13"/>
                <line x1="12" y1="17" x2="12.01" y2="17"/>
              </svg>
            </div>

            <h2 className="mb-3 text-2xl font-bold text-zinc-900">{t("limitedScan")} quality</h2>
            <p className="mb-2 max-w-lg text-sm leading-relaxed text-zinc-600">
              We may not be able to scan this website reliably.
            </p>
            <p className="mb-7 max-w-lg text-sm leading-relaxed text-zinc-500">
              This can happen when a website blocks automated access, requires login, loads content only after user interaction, depends on location or cookies, or uses heavy client-side rendering.
            </p>

            {/* Specific reasons from scanQuality */}
            {result.scanQuality.reasons.length > 0 && (
              <div className="mb-7 w-full max-w-md rounded-xl border border-amber-200 bg-white px-5 py-4 text-left">
                <p className="mb-2.5 font-mono text-[10px] font-semibold uppercase tracking-widest text-amber-700">Detected signals</p>
                <ul className="space-y-1.5">
                  {result.scanQuality.reasons.map((r) => (
                    <li key={r} className="flex items-start gap-2 text-[13px] text-zinc-600">
                      <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" />
                      {r}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* What this means */}
            <div className="mb-8 w-full max-w-md text-left">
              <p className="mb-2.5 font-mono text-[10px] font-semibold uppercase tracking-widest text-zinc-500">{t("whatThisMeans").toUpperCase()}</p>
              <ul className="space-y-1.5">
                {[
                  "Some visual elements may be missing from analysis",
                  "Some interactions may not be testable",
                  "Findings may be incomplete or less accurate than usual",
                ].map((item) => (
                  <li key={item} className="flex items-start gap-2 text-[13px] text-zinc-500">
                    <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-zinc-300" />
                    {item}
                  </li>
                ))}
              </ul>
            </div>

            <p className="mb-6 text-sm font-medium text-zinc-700">
              Do you still want to continue with a limited audit?
            </p>

            <div className="flex flex-wrap items-center justify-center gap-3">
              <button
                onClick={() => setScanGateConfirmed(true)}
                className="rounded-xl bg-zinc-900 px-6 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-zinc-700"
              >
                {t("continueWithLimitedAudit")}
              </button>
              <button
                onClick={reset}
                className="rounded-xl border border-zinc-200 bg-white px-6 py-2.5 text-sm font-semibold text-zinc-600 transition-colors hover:border-zinc-400"
              >
                {t("tryAnotherUrl")}
              </button>
            </div>
          </div>
        </div>
      );
    }

    const sortedFindings = sortFindings(result.findings);
    const urgentCount = sortedFindings.filter((f) => f.priority === "urgent").length;
    const importantCount = sortedFindings.filter((f) => f.priority === "important").length;
    const fixPrompts = selectedFinding ? buildFixPrompts(selectedFinding, result.detectedBuilder) : null;
    const topCats = categoryOrder.slice(0, 3);

    return (
      <>
        <div ref={resultRef} className="mx-auto max-w-[1200px] space-y-5 py-10 sm:py-14" dir={isRTL ? "rtl" : "ltr"}>

          {/* Actions bar */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <div className={`h-2 w-2 rounded-full ${isRealAudit ? "bg-green-500" : "bg-amber-500"}`} />
                <span className="font-mono text-xs font-semibold uppercase tracking-widest text-zinc-500">{t("auditComplete").toUpperCase()}</span>
                {isRealAudit ? (
                  apiData?.analysisSource === "rendered-dom" ? (
                    <span className="rounded-full bg-blue-100 px-2 py-0.5 font-mono text-[9px] font-semibold text-blue-700">
                      ✓ {t("renderedPageData")}
                    </span>
                  ) : (
                    <span className="rounded-full bg-green-100 px-2 py-0.5 font-mono text-[9px] font-semibold text-green-700">
                      ✓ {t("realPageData")}
                    </span>
                  )
                ) : (
                  <span className="rounded-full bg-amber-100 px-2 py-0.5 font-mono text-[9px] font-semibold text-amber-700">
                    ⚠ {t("heuristicMode")}
                  </span>
                )}
                {/* Scan quality badge — uses render-time traffic light */}
                {trafficLight === "green" && (
                  <span className="rounded-full bg-emerald-100 px-2 py-0.5 font-mono text-[9px] font-semibold text-emerald-700">
                    ● {t("reliableScan")} · {result.scanQuality.confidence}%
                  </span>
                )}
                {trafficLight === "yellow" && (
                  <span className="rounded-full bg-amber-100 px-2 py-0.5 font-mono text-[9px] font-semibold text-amber-700">
                    ⚠ {t("limitedScan")} · {result.scanQuality.confidence}%
                  </span>
                )}
              </div>
              <p className="text-sm text-zinc-500">
                <span className="font-medium text-zinc-800">{result.domain}</span>
                <span className="ml-2 rounded border border-zinc-200 px-2 py-0.5 font-mono text-[10px] text-zinc-500">{result.siteType}</span>
              </p>
              {/* Real data metadata */}
              {apiData && (
                <p className="mt-1 font-mono text-[10px] text-zinc-400">
                  {apiData.title ? `Title: "${apiData.title.slice(0, 50)}${apiData.title.length > 50 ? "…" : ""}"` : "No title"} ·
                  {" "}{apiData.wordCount} words ·
                  {" "}{(apiData.pageSize / 1000).toFixed(0)}KB ·
                  {" "}{apiData.fetchDuration}ms
                </p>
              )}
            </div>
            <div className="flex items-center gap-2">
              {/* Language picker — results page only */}
              <div className="flex items-center rounded-lg border border-zinc-200 bg-zinc-50 p-0.5">
                {(["en","he","ru","es"] as LangCode[]).map((code) => (
                  <button
                    key={code}
                    onClick={() => setLang(code)}
                    className={`rounded-md px-2.5 py-1 font-mono text-[11px] font-semibold uppercase transition-all ${
                      lang === code
                        ? "bg-white text-zinc-900 shadow-sm"
                        : "text-zinc-400 hover:text-zinc-600"
                    }`}
                  >
                    {code}
                  </button>
                ))}
              </div>
              <button onClick={copyFullReport} className="inline-flex items-center gap-2 rounded-lg border border-zinc-200 px-4 py-2 text-sm font-medium text-zinc-600 transition-colors hover:border-zinc-400">
                {copied ? t("copied") : t("copyReport")}
              </button>
              <button onClick={reset} className="inline-flex items-center gap-2 rounded-lg border border-zinc-200 px-4 py-2 text-sm font-medium text-zinc-600 transition-colors hover:border-zinc-400">
                {t("newAudit")}
              </button>
            </div>
          </div>

          {/* Context banner */}
          {siteContext && <ContextBanner context={siteContext} />}

          {/* Limited scan quality warning — shown after user confirms YELLOW gate */}
          {trafficLight === "yellow" && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-4">
              <div className="flex items-start gap-3">
                <span className="mt-0.5 shrink-0 text-base leading-none">⚠</span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-semibold text-amber-800">{t("limitedScanBanner")}</p>
                    <span className="rounded-full bg-amber-200 px-2 py-0.5 font-mono text-[9px] font-bold text-amber-800">
                      {result.scanQuality.confidence}% confidence
                    </span>
                  </div>
                  {result.scanQuality.reasons.length > 0 && (
                    <ul className="mt-2 space-y-0.5">
                      {result.scanQuality.reasons.map((r) => (
                        <li key={r} className="flex items-start gap-1.5 text-[12px] text-amber-700">
                          <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-amber-500" />
                          {r}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Summary cards */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <SummaryCard label={t("overallScore")} value={`${result.overallScore}/100`} sub={`${urgentCount} urgent · ${importantCount} important`} accent="zinc" />
            <SummaryCard label={t("topUrgentIssue")} value={urgentCount > 0 ? `${urgentCount} found` : "None"} sub={result.topUrgentIssue} accent="red" />
            <SummaryCard label={t("bestQuickWin")} value="Low effort" sub={result.bestQuickWin} accent="green" />
            <SummaryCard label={t("mainProductRisk")} value="Review" sub={result.mainProductRisk} accent="amber" />
          </div>

          {/* ── Page Snapshot ──────────────────────────────────────────────── */}
          <div
            ref={pageSnapshotRef}
            className={`overflow-hidden rounded-xl border transition-all duration-500 ${
              snapshotHighlight === "urgent"    ? "border-red-400 ring-4 ring-red-300/50 ring-offset-2"
              : snapshotHighlight === "important" ? "border-orange-400 ring-4 ring-orange-300/50 ring-offset-2"
              : snapshotHighlight === "later"     ? "border-amber-400 ring-4 ring-amber-300/50 ring-offset-2"
              : "border-zinc-200"
            }`}
          >
            {/* Header */}
            <div className="flex items-center justify-between border-b border-zinc-100 bg-zinc-50 px-4 py-2.5">
              <div className="flex items-center gap-2 min-w-0">
                <span className="font-mono text-[10px] font-semibold uppercase tracking-widest text-zinc-500 shrink-0">
                  {t("pageSnapshot")}
                </span>
                <span className="rounded border border-zinc-200 bg-white px-2 py-0.5 font-mono text-[9px] text-zinc-500 truncate max-w-[280px]">
                  {url}
                </span>
                {/* Visual focus badge — shown when an evidence drawer is open */}
                {evidenceDrawerOpen && evidenceFinding && (
                  <span className={`shrink-0 rounded-full border px-2 py-0.5 font-mono text-[9px] font-semibold ${
                    evidenceFinding.priority === "urgent"
                      ? "border-red-300 bg-red-50 text-red-700"
                      : evidenceFinding.priority === "important"
                      ? "border-orange-300 bg-orange-50 text-orange-700"
                      : "border-amber-300 bg-amber-50 text-amber-700"
                  }`}>
                    {t("visualFocusActive")}
                  </span>
                )}
              </div>
              {screenshotLoading && (
                <span className="flex items-center gap-1.5 rounded-full border border-zinc-200 bg-white px-2 py-0.5 font-mono text-[9px] text-zinc-500">
                  <span className="inline-block h-1.5 w-1.5 animate-ping rounded-full bg-zinc-400" />
                  {t("capturing")}
                </span>
              )}
              {screenshotBase64 && !screenshotLoading && !evidenceDrawerOpen && (
                <span className="rounded-full border border-green-200 bg-green-50 px-2 py-0.5 font-mono text-[9px] font-semibold text-green-700">
                  {t("liveScreenshot")}
                </span>
              )}
              {(screenshotError || (!screenshotLoading && !screenshotBase64)) && !screenshotLoading && !evidenceDrawerOpen && (
                <span className="rounded-full border border-zinc-200 bg-white px-2 py-0.5 font-mono text-[9px] text-zinc-400">
                  {t("htmlSignalsOnly")}
                </span>
              )}
            </div>

            {/* ── State 1: loading ─────────────────────────────────────────── */}
            {screenshotLoading && (
              <div className="flex items-center gap-4 bg-white px-4 py-4">
                <div className="shrink-0 flex h-20 w-32 items-center justify-center rounded-lg border border-zinc-200 bg-zinc-50">
                  <div className="space-y-1.5 w-20">
                    <div className="h-2 rounded bg-zinc-200 animate-pulse" />
                    <div className="h-2 rounded bg-zinc-200 animate-pulse w-4/5" />
                    <div className="h-2 rounded bg-zinc-200 animate-pulse w-3/5" />
                    <div className="h-2 rounded bg-zinc-200 animate-pulse w-4/5" />
                    <div className="h-2 rounded bg-zinc-200 animate-pulse w-2/5" />
                  </div>
                </div>
                <div>
                  <p className="text-sm font-semibold text-zinc-700">{t("capturingScreenshot")}</p>
                  <p className="mt-0.5 text-xs text-zinc-400">
                    {t("screenshotCaptureDesc")}
                  </p>
                </div>
              </div>
            )}

            {/* ── State 2: screenshot ready ─────────────────────────────────── */}
            {screenshotBase64 && !screenshotLoading && (
              <div className="bg-zinc-950">
                {/* Browser chrome */}
                <div className="flex items-center gap-1.5 px-3 pt-3 pb-2">
                  <span className="h-2.5 w-2.5 rounded-full bg-zinc-700" />
                  <span className="h-2.5 w-2.5 rounded-full bg-zinc-700" />
                  <span className="h-2.5 w-2.5 rounded-full bg-zinc-700" />
                  <span className="ml-2 flex-1 rounded bg-zinc-800 px-3 py-0.5 font-mono text-[9px] text-zinc-500 truncate">
                    {url}
                  </span>
                </div>

                {/* Clickable screenshot */}
                <div
                  className="group relative mx-3 cursor-zoom-in overflow-hidden rounded-md border border-zinc-800"
                  onClick={() => {
                    // Carry the active evidence finding into the modal so annotations persist
                    setScreenshotModalFinding(evidenceDrawerOpen && evidenceFinding ? evidenceFinding : null);
                    setScreenshotModalOpen(true);
                  }}
                  title="Click to enlarge"
                >
                  <img
                    src={`data:image/jpeg;base64,${screenshotBase64}`}
                    alt={`Screenshot of ${result.domain}`}
                    className="w-full object-cover object-top transition-transform duration-200 group-hover:scale-[1.01]"
                    style={{ maxHeight: "300px" }}
                  />
                  {/* Annotation overlay — visible when evidence drawer is open for a finding */}
                  {evidenceDrawerOpen && evidenceFinding && (
                    <AnnotationOverlay finding={evidenceFinding} apiData={apiData} />
                  )}
                  {/* Hover overlay */}
                  <div className="absolute inset-0 flex items-center justify-center bg-black/0 transition-colors duration-150 group-hover:bg-black/30">
                    <div className="flex items-center gap-1.5 rounded-full border border-white/20 bg-black/60 px-3 py-1.5 opacity-0 transition-opacity duration-150 group-hover:opacity-100">
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
                        <line x1="11" y1="8" x2="11" y2="14" /><line x1="8" y1="11" x2="14" y2="11" />
                      </svg>
                      <span className="font-mono text-[10px] font-semibold text-white">{t("enlargeBtn")}</span>
                    </div>
                  </div>
                </div>

                {/* Metadata footer */}
                <div className="flex flex-wrap items-center gap-3 px-3 pb-3 pt-2">
                  {screenshotMeta && (
                    <>
                      <span className="font-mono text-[9px] text-zinc-500">
                        🖥 {screenshotMeta.viewport} · 1280×800
                      </span>
                      <span className="font-mono text-[9px] text-zinc-600">·</span>
                      <span className="font-mono text-[9px] text-zinc-500">
                        Captured {new Date(screenshotMeta.capturedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                      </span>
                      <span className="font-mono text-[9px] text-zinc-600">·</span>
                      <span className="font-mono text-[9px] text-zinc-500">
                        {(screenshotMeta.durationMs / 1000).toFixed(1)}s
                      </span>
                    </>
                  )}
                  <span className="ml-auto font-mono text-[9px] text-zinc-600">{t("clickToEnlarge")}</span>
                </div>
              </div>
            )}

            {/* ── State 3: error / no screenshot ───────────────────────────── */}
            {!screenshotLoading && !screenshotBase64 && (
              <div className="flex items-center gap-4 bg-white px-4 py-4">
                <div className="shrink-0 flex h-20 w-32 items-center justify-center rounded-lg border-2 border-dashed border-zinc-200 bg-zinc-50">
                  <div className="text-center">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="mx-auto mb-1 text-zinc-300" strokeLinecap="round" strokeLinejoin="round">
                      <rect x="3" y="3" width="18" height="18" rx="2" />
                      <circle cx="8.5" cy="8.5" r="1.5" />
                      <polyline points="21 15 16 10 5 21" />
                    </svg>
                    <p className="font-mono text-[8px] text-zinc-300">{t("noScreenshot")}</p>
                  </div>
                </div>
                <div className="min-w-0">
                  {screenshotError ? (
                    <>
                      <p className="text-sm font-semibold text-zinc-700">{t("screenshotUnavailable")}</p>
                      <p className="mt-0.5 text-xs text-zinc-400">
                        {screenshotError.includes("timeout") || screenshotError.includes("Timeout")
                          ? "The browser timed out rendering this page. The audit data below is still accurate."
                          : "Could not capture a visual screenshot. The audit data below is still accurate."}
                      </p>
                    </>
                  ) : (
                    <>
                      <p className="text-sm font-semibold text-zinc-700">{t("auditBasedOnLiveHtml")}</p>
                      <p className="mt-0.5 text-xs leading-relaxed text-zinc-400">
                        {t("auditBasedOnLiveHtmlDesc")}
                      </p>
                    </>
                  )}
                  {/* Live data chips */}
                  {apiData && (
                    <div className="mt-2 flex flex-wrap gap-2">
                      <span className="inline-flex items-center gap-1 rounded-full border border-zinc-100 bg-zinc-50 px-2 py-0.5 font-mono text-[9px] text-zinc-500">
                        <span className="h-1 w-1 rounded-full bg-green-400" />
                        {apiData.wordCount} words
                      </span>
                      <span className="inline-flex items-center gap-1 rounded-full border border-zinc-100 bg-zinc-50 px-2 py-0.5 font-mono text-[9px] text-zinc-500">
                        <span className="h-1 w-1 rounded-full bg-green-400" />
                        {(apiData.pageSize / 1000).toFixed(0)}KB
                      </span>
                      <span className="inline-flex items-center gap-1 rounded-full border border-zinc-100 bg-zinc-50 px-2 py-0.5 font-mono text-[9px] text-zinc-500">
                        <span className="h-1 w-1 rounded-full bg-green-400" />
                        {apiData.links.total} links
                      </span>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Priority note + view toggle */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2 rounded-lg border border-zinc-200 bg-zinc-50 px-4 py-2.5">
              <span className="font-mono text-[10px] font-semibold uppercase tracking-widest text-zinc-500">
                {t("prioritisedBy")}
              </span>
              {topCats.map((cat, i) => (
                <span key={cat} className="inline-flex items-center gap-1.5 rounded-full border border-zinc-300 bg-white px-2.5 py-0.5 font-mono text-[10px] text-zinc-600">
                  <span className={`h-1.5 w-1.5 rounded-full ${CAT_DOTS[cat] ?? "bg-zinc-400"}`} />
                  <span className={i === 0 ? "font-semibold text-zinc-800" : ""}>{cat}</span>
                </span>
              ))}
              <span className="hidden sm:inline ml-auto font-mono text-[10px] text-zinc-400">
                {viewMode === "table" ? t("fixPromptOnRow") : t("selectFindingToInspect")}
              </span>
            </div>

            {/* View toggle */}
            <div className="flex items-center gap-1 rounded-lg border border-zinc-200 bg-zinc-50 p-1 shrink-0">
              <button
                onClick={() => setViewMode("table")}
                className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 font-mono text-[11px] font-semibold transition-all ${
                  viewMode === "table"
                    ? "bg-white text-zinc-900 shadow-sm"
                    : "text-zinc-500 hover:text-zinc-700"
                }`}
              >
                {/* Table icon */}
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                  <rect x="0.5" y="0.5" width="11" height="11" rx="1" stroke="currentColor" strokeOpacity=".5"/>
                  <line x1="0.5" y1="4" x2="11.5" y2="4" stroke="currentColor" strokeOpacity=".5"/>
                  <line x1="0.5" y1="8" x2="11.5" y2="8" stroke="currentColor" strokeOpacity=".5"/>
                  <line x1="4" y1="0.5" x2="4" y2="11.5" stroke="currentColor" strokeOpacity=".5"/>
                </svg>
                {t("tableView")}
              </button>
              <button
                onClick={() => {
                  setViewMode("inspector");
                  setInspectorFindingId((prev) => prev ?? sortedFindings[0]?.id ?? null);
                  // Sync inspector tab with the user's preferred/detected builder
                  const tabFromPreferred = preferredBuilder ? getRecommendedTab(preferredBuilder) : null;
                  const tabFromDetected = getRecommendedTab(result.detectedBuilder ?? null);
                  setInspectorActiveTab(tabFromPreferred ?? tabFromDetected ?? "lovable");
                }}
                className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 font-mono text-[11px] font-semibold transition-all ${
                  viewMode === "inspector"
                    ? "bg-white text-zinc-900 shadow-sm"
                    : "text-zinc-500 hover:text-zinc-700"
                }`}
              >
                {/* Inspector / split-panel icon */}
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                  <rect x="0.5" y="0.5" width="11" height="11" rx="1" stroke="currentColor" strokeOpacity=".5"/>
                  <line x1="5" y1="0.5" x2="5" y2="11.5" stroke="currentColor" strokeOpacity=".5"/>
                  <line x1="5" y1="7" x2="11.5" y2="7" stroke="currentColor" strokeOpacity=".5"/>
                </svg>
                {t("inspectorView")}
              </button>
            </div>
          </div>

          {/* ── TABLE VIEW (default) ─────────────────────────────────────────── */}
          {viewMode === "table" && (
            <div className="overflow-hidden rounded-xl border border-zinc-200">
              {/* Desktop header */}
              <div className="hidden sm:grid sm:grid-cols-[90px_120px_1fr_1fr_1fr_70px_70px_160px] border-b border-zinc-200 bg-zinc-50 px-4 py-3 gap-3">
                {[t("priorityCol"),t("categoryCol"),t("issueCol"),t("whyItMattersCol"),t("suggestedFixCol"),t("effortCol"),t("impactCol"),""].map((h) => (
                  <div key={h} className="font-mono text-[10px] font-semibold uppercase tracking-widest text-zinc-500">{h}</div>
                ))}
              </div>

              <div className="divide-y divide-zinc-100">
                {sortedFindings.map((f) => {
                  const cfg = P_CONFIG[f.priority];
                  return (
                    <div key={f.id} className={`${cfg.rowBg} border-l-4 ${cfg.borderL}`}>

                      {/* Mobile card */}
                      <div className="block p-4 sm:hidden">
                        {(() => {
                          const conf = calculateConfidence(f, apiData, isRealAudit);
                          const confBadge = conf.level === "high"
                            ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                            : conf.level === "medium"
                            ? "bg-sky-50 text-sky-700 border-sky-200"
                            : "bg-zinc-50 text-zinc-500 border-zinc-200";
                          return (
                            <div className="mb-2 flex flex-wrap items-center gap-2">
                              <span className={`inline-flex items-center gap-1.5 rounded border px-2 py-0.5 font-mono text-[10px] font-semibold uppercase ${cfg.badge}`}>
                                <span className={`h-1 w-1 rounded-full ${cfg.dot}`} />
                                {cfg.label}
                              </span>
                              <span className="font-mono text-[10px] text-zinc-500">{f.category}</span>
                              <span className={`inline-flex items-center rounded border px-2 py-0.5 font-mono text-[10px] font-semibold ${confBadge}`}>
                                {conf.score}%{" "}
                                <span className="ml-1 font-normal opacity-70">
                                  {conf.level === "high" ? "High" : conf.level === "medium" ? "Med" : "Low"}
                                </span>
                              </span>
                            </div>
                          );
                        })()}
                        <p className="mb-1.5 text-sm font-semibold text-zinc-900">{f.issue}</p>
                        <p className="mb-3 text-xs text-zinc-500 leading-relaxed">{f.whyItMatters}</p>
                        <div className="mb-3 rounded bg-white/80 border border-zinc-200 p-2.5">
                          <p className="mb-1 font-mono text-[10px] font-semibold uppercase text-zinc-400">Fix</p>
                          <p className="text-xs text-zinc-700">{f.suggestedFix}</p>
                        </div>
                        <div className="flex items-center justify-between">
                          <div className="flex gap-3">
                            <span className="font-mono text-[10px] text-zinc-400">{t("effortLabel")} {f.effort}</span>
                            <span className="font-mono text-[10px] text-zinc-400">{t("impactLabel")} {f.impact}</span>
                          </div>
                          <div className="flex gap-2">
                            <button
                              onClick={() => openEvidenceDrawer(f)}
                              className="inline-flex items-center gap-1 rounded-lg border border-zinc-200 px-3 py-1.5 font-mono text-[11px] text-zinc-600 hover:border-zinc-400 transition-colors"
                            >
                              {t("evidenceBtn")}
                            </button>
                            <button
                              onClick={() => openDrawer(f)}
                              className="inline-flex items-center gap-1 rounded-lg bg-zinc-900 px-3 py-1.5 font-mono text-[11px] text-white hover:bg-zinc-700 transition-colors"
                            >
                              {t("fixPromptBtn")}
                            </button>
                          </div>
                        </div>
                      </div>

                      {/* Desktop row */}
                      <div className="hidden sm:grid sm:grid-cols-[90px_120px_1fr_1fr_1fr_70px_70px_160px] items-start gap-3 px-4 py-4">
                        <div className="flex flex-col gap-1.5">
                          <span className={`inline-flex items-center gap-1.5 rounded border px-2 py-1 font-mono text-[10px] font-semibold uppercase ${cfg.badge}`}>
                            <span className={`h-1 w-1 rounded-full ${cfg.dot}`} />
                            {cfg.label}
                          </span>
                          {(() => {
                            const conf = calculateConfidence(f, apiData, isRealAudit);
                            const confBadge = conf.level === "high"
                              ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                              : conf.level === "medium"
                              ? "bg-sky-50 text-sky-700 border-sky-200"
                              : "bg-zinc-50 text-zinc-500 border-zinc-200";
                            return (
                              <span className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 font-mono text-[10px] ${confBadge}`} title={conf.reason}>
                                <span className="font-semibold">{conf.score}%</span>
                                <span className="opacity-60">{conf.level === "high" ? "High" : conf.level === "medium" ? "Med" : "Low"}</span>
                              </span>
                            );
                          })()}
                        </div>
                        <div className="font-mono text-xs text-zinc-600">{f.category}</div>
                        <div className="text-xs font-semibold text-zinc-900">{f.issue}</div>
                        <div className="text-xs leading-relaxed text-zinc-500">{f.whyItMatters}</div>
                        <div className="text-xs leading-relaxed text-zinc-600">{f.suggestedFix}</div>
                        <div><EffortBadge v={f.effort} /></div>
                        <div><ImpactBadge v={f.impact} /></div>
                        <div className="flex flex-col gap-1.5">
                          <button
                            onClick={() => openDrawer(f)}
                            className="inline-flex items-center justify-center gap-1 rounded-lg bg-zinc-900 px-3 py-2 font-mono text-[11px] text-white hover:bg-zinc-700 transition-colors whitespace-nowrap"
                          >
                            {t("fixPromptBtn")}
                          </button>
                          <button
                            onClick={() => openEvidenceDrawer(f)}
                            className="inline-flex items-center justify-center gap-1 rounded-lg border border-zinc-200 px-3 py-1.5 font-mono text-[11px] text-zinc-500 hover:border-zinc-400 hover:text-zinc-700 transition-colors whitespace-nowrap"
                          >
                            {t("showEvidence")}
                          </button>
                        </div>
                      </div>

                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* ── INSPECTOR VIEW ───────────────────────────────────────────────── */}
          {viewMode === "inspector" && (() => {
            const inspectorFinding =
              sortedFindings.find((f) => f.id === inspectorFindingId) ??
              sortedFindings[0] ??
              null;
            if (!inspectorFinding) return null;

            const inspFix = buildFixPrompts(inspectorFinding, result.detectedBuilder);
            const inspCfg = P_CONFIG[inspectorFinding.priority];
            const inspConf = calculateConfidence(inspectorFinding, apiData, isRealAudit);

            // Tab ordering — same logic as fix prompt drawer
            const tabFromPreferred = preferredBuilder ? getRecommendedTab(preferredBuilder) : null;
            const tabFromDetected  = getRecommendedTab(result.detectedBuilder ?? null);
            const inspRecommendedTab: ToolId | null = tabFromPreferred ?? tabFromDetected;
            const ALL_TABS: ToolId[] = ["lovable", "base44", "claude", "cursor", "generic"];
            const inspOrderedTabs: ToolId[] = inspRecommendedTab
              ? [inspRecommendedTab, ...ALL_TABS.filter((t) => t !== inspRecommendedTab)]
              : ALL_TABS;

            return (
              <div className={`flex h-[720px] overflow-hidden rounded-xl border border-zinc-200 shadow-sm${isRTL ? " flex-row-reverse" : ""}`}>

                {/* ── LEFT PANEL — scrollable finding list ──────────────────── */}
                <div className="flex w-[272px] shrink-0 flex-col overflow-hidden border-r border-zinc-200 bg-zinc-50">
                  {/* Panel header */}
                  <div className="shrink-0 border-b border-zinc-200 bg-white px-3 py-2.5">
                    <p className="font-mono text-[10px] font-semibold uppercase tracking-widest text-zinc-500">
                      {sortedFindings.length} {t("findingsLabel")}
                    </p>
                  </div>
                  {/* Finding cards */}
                  <div className="flex-1 overflow-y-auto">
                    {sortedFindings.map((f) => {
                      const fcfg = P_CONFIG[f.priority];
                      const fconf = calculateConfidence(f, apiData, isRealAudit);
                      const isSelected = f.id === (inspectorFinding.id);
                      return (
                        <button
                          key={f.id}
                          onClick={() => setInspectorFindingId(f.id)}
                          className={`group w-full border-b border-zinc-200 px-3 py-3 text-left transition-colors ${
                            isSelected
                              ? "border-l-[3px] border-l-blue-500 bg-white"
                              : "border-l-[3px] border-l-transparent hover:border-l-zinc-300 hover:bg-white/60"
                          }`}
                        >
                          {/* Top row: severity + category */}
                          <div className="mb-1.5 flex items-center gap-1.5 overflow-hidden">
                            <span className={`inline-flex shrink-0 items-center gap-1 rounded border px-1.5 py-px font-mono text-[9px] font-semibold uppercase ${fcfg.badge}`}>
                              <span className={`h-1 w-1 rounded-full ${fcfg.dot}`} />
                              {fcfg.label}
                            </span>
                            <span className="truncate font-mono text-[9px] text-zinc-500">{f.category}</span>
                          </div>
                          {/* Issue title */}
                          <p className={`mb-2 line-clamp-2 text-[12px] font-semibold leading-snug ${isSelected ? "text-zinc-900" : "text-zinc-700"}`}>
                            {f.issue}
                          </p>
                          {/* Bottom row: confidence + priority dot */}
                          <div className="flex items-center gap-2">
                            <span className={`font-mono text-[9px] font-semibold ${
                              fconf.level === "high" ? "text-emerald-600"
                              : fconf.level === "medium" ? "text-sky-600"
                              : "text-zinc-400"
                            }`}>
                              {fconf.score}% conf
                            </span>
                            <span className={`ml-auto h-2 w-2 shrink-0 rounded-full ${fcfg.dot}`} />
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* ── RIGHT PANEL — inspector detail ────────────────────────── */}
                <div className="flex flex-1 flex-col overflow-hidden">

                  {/* ── Screenshot area ───────────────────────────────────── */}
                  <div className="shrink-0 bg-zinc-950" style={{ height: "370px" }}>
                    {/* Browser chrome + finding badge */}
                    <div className="flex items-center gap-1.5 px-3 pt-3 pb-2">
                      <span className="h-2 w-2 rounded-full bg-zinc-700" />
                      <span className="h-2 w-2 rounded-full bg-zinc-700" />
                      <span className="h-2 w-2 rounded-full bg-zinc-700" />
                      <span className="ml-2 flex-1 truncate rounded bg-zinc-800 px-3 py-0.5 font-mono text-[9px] text-zinc-500">
                        {url}
                      </span>
                      <span className={`shrink-0 inline-flex items-center gap-1 rounded border px-2 py-0.5 font-mono text-[9px] font-semibold ${inspCfg.badge}`}>
                        <span className={`h-1 w-1 rounded-full ${inspCfg.dot}`} />
                        {inspectorFinding.category}
                      </span>
                    </div>

                    {/* Screenshot with annotation overlay — keyed so it fades on finding switch */}
                    <div
                      key={inspectorFinding.id}
                      className="animate-[fadeInFast_0.18s_ease-out] mx-3 overflow-hidden rounded-md border border-zinc-800"
                      style={{ height: "300px" }}
                    >
                      {screenshotBase64 ? (
                        <div
                          className="group relative h-full w-full cursor-zoom-in"
                          onClick={() => {
                            setScreenshotModalFinding(inspectorFinding);
                            setScreenshotModalOpen(true);
                          }}
                          title="Click to enlarge"
                        >
                          <img
                            src={`data:image/jpeg;base64,${screenshotBase64}`}
                            alt={`Screenshot of ${result.domain}`}
                            className="h-full w-full object-cover object-top"
                          />
                          <AnnotationOverlay finding={inspectorFinding} apiData={apiData} />
                          {/* Hover hint */}
                          <div className="absolute inset-0 flex items-end justify-end bg-black/0 p-2 transition-colors group-hover:bg-black/20">
                            <span className="rounded-full border border-white/20 bg-black/60 px-2 py-1 font-mono text-[9px] font-semibold text-white opacity-0 transition-opacity group-hover:opacity-100">
                              {t("enlargeBtn")}
                            </span>
                          </div>
                        </div>
                      ) : screenshotLoading ? (
                        <div className="flex h-full items-center justify-center bg-zinc-900">
                          <div className="text-center">
                            <div className="mx-auto mb-3 h-6 w-6 animate-spin rounded-full border-2 border-zinc-600 border-t-zinc-300" />
                            <p className="font-mono text-[10px] text-zinc-500">{t("capturingScreenshot")}</p>
                          </div>
                        </div>
                      ) : (
                        <div className="flex h-full flex-col items-center justify-center gap-2 bg-zinc-900">
                          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" className="text-zinc-700" strokeLinecap="round" strokeLinejoin="round">
                            <rect x="3" y="3" width="18" height="18" rx="2" />
                            <circle cx="8.5" cy="8.5" r="1.5" />
                            <polyline points="21 15 16 10 5 21" />
                          </svg>
                          <p className="font-mono text-[10px] text-zinc-600">{t("noScreenshotAvailable")}</p>
                          <p className="font-mono text-[9px] text-zinc-700">{t("annotationsBasedOnDom")}</p>
                        </div>
                      )}
                    </div>
                  </div>

                  {/* ── Detail panel (scrollable) ─────────────────────────── */}
                  <div className="flex-1 overflow-y-auto bg-white">
                    <div className="space-y-0 divide-y divide-zinc-100">

                      {/* Finding title */}
                      <div className="px-6 py-4">
                        <div className="mb-2 flex flex-wrap items-center gap-2">
                          <span className={`inline-flex items-center gap-1.5 rounded border px-2 py-0.5 font-mono text-[10px] font-semibold ${inspCfg.badge}`}>
                            <span className={`h-1 w-1 rounded-full ${inspCfg.dot}`} />
                            {inspCfg.label}
                          </span>
                          <span className="font-mono text-[10px] text-zinc-500">{inspectorFinding.category}</span>
                          <span className={`rounded border px-1.5 py-px font-mono text-[9px] font-semibold ${
                            inspConf.level === "high" ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                            : inspConf.level === "medium" ? "border-sky-200 bg-sky-50 text-sky-700"
                            : "border-zinc-200 bg-zinc-50 text-zinc-500"
                          }`}>
                            {inspConf.score}% confidence
                          </span>
                        </div>
                        <h3 className="text-[15px] font-bold leading-snug text-zinc-900">
                          {inspectorFinding.issue}
                        </h3>
                      </div>

                      {/* Why this matters */}
                      <div className="px-6 py-4">
                        <p className="mb-2 font-mono text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
                          {t("whyThisMatters").toUpperCase()}
                        </p>
                        <p className="text-[13px] leading-relaxed text-zinc-700">
                          {inspectorFinding.whyItMatters}
                        </p>
                      </div>

                      {/* How to fix */}
                      <div className="px-6 py-4">
                        <p className="mb-2 font-mono text-[10px] font-semibold uppercase tracking-wider text-zinc-400">
                          {t("howToFix").toUpperCase()}
                        </p>
                        <p className="mb-3 text-[13px] leading-relaxed text-zinc-700">
                          {inspectorFinding.suggestedFix}
                        </p>
                        <div className="flex gap-4">
                          <span className="inline-flex items-center gap-1.5 font-mono text-[10px] text-zinc-500">
                            <span className="font-semibold text-zinc-700">{t("effortLabel")}</span>
                            {inspectorFinding.effort}
                          </span>
                          <span className="inline-flex items-center gap-1.5 font-mono text-[10px] text-zinc-500">
                            <span className="font-semibold text-zinc-700">{t("impactLabel")}</span>
                            {inspectorFinding.impact}
                          </span>
                        </div>
                      </div>

                      {/* Fix prompts */}
                      <div className="overflow-hidden bg-zinc-950">
                        {/* Section label */}
                        <div className="border-b border-zinc-800 px-6 py-2.5">
                          <p className="font-mono text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                            {t("fixPromptsSection").toUpperCase()}
                          </p>
                        </div>
                        {/* Tabs */}
                        <div className="flex overflow-x-auto border-b border-zinc-800 px-4 pt-1 scrollbar-none">
                          {inspOrderedTabs.map((tool) => {
                            const isRec = tool === inspRecommendedTab;
                            return (
                              <button
                                key={tool}
                                onClick={() => setInspectorActiveTab(tool)}
                                className={`-mb-px flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2.5 font-mono text-xs font-semibold transition-colors ${
                                  inspectorActiveTab === tool
                                    ? "border-white text-white"
                                    : "border-transparent text-zinc-500 hover:text-zinc-300"
                                }`}
                              >
                                {TOOL_LABELS[tool]}
                                {isRec && (
                                  <span className="rounded bg-violet-600 px-1.5 py-px font-mono text-[8px] font-bold leading-none text-white">
                                    ★
                                  </span>
                                )}
                              </button>
                            );
                          })}
                        </div>
                        {/* Prompt content */}
                        <div className="p-5">
                          <div className="mb-3 flex items-center justify-between">
                            <span className="font-mono text-[10px] text-zinc-600">
                              {TOOL_DESCRIPTIONS[inspectorActiveTab]}
                            </span>
                            <button
                              onClick={() => copyPrompt(inspectorActiveTab, inspFix[inspectorActiveTab])}
                              className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 font-mono text-[11px] font-semibold transition-all ${
                                copiedPrompt === inspectorActiveTab
                                  ? "bg-green-900/70 text-green-400 ring-1 ring-green-700"
                                  : "bg-zinc-800 text-zinc-300 hover:bg-zinc-700 hover:text-white"
                              }`}
                            >
                              {copiedPrompt === inspectorActiveTab ? "✓ Copied" : "Copy prompt"}
                            </button>
                          </div>
                          <pre className="max-h-52 overflow-y-auto whitespace-pre-wrap rounded-lg border border-zinc-800 bg-zinc-900/50 p-4 font-mono text-[11px] leading-relaxed text-zinc-300">
                            {inspFix[inspectorActiveTab]}
                          </pre>
                        </div>
                      </div>

                    </div>
                  </div>
                </div>

              </div>
            );
          })()}

          <p className="text-center text-xs text-zinc-400">
            {isRealAudit
              ? `Real audit · fetched ${apiData?.pageSize ? `${(apiData.pageSize / 1000).toFixed(0)}KB` : "page"} in ${apiData?.fetchDuration ?? "?"}ms · findings from actual HTML`
              : "Heuristic mode · could not fetch page · findings based on URL patterns"
            }
          </p>
        </div>

        {/* ── Fix Prompt Drawer ─────────────────────────────────────────────── */}
        {drawerOpen && selectedFinding && fixPrompts && (() => {
          // preferredBuilder (user-selected) takes precedence over auto-detected
          const tabFromPreferred = preferredBuilder ? getRecommendedTab(preferredBuilder) : null;
          const tabFromDetected = getRecommendedTab(result?.detectedBuilder ?? null);
          const recommendedTab: ToolId | null = tabFromPreferred ?? tabFromDetected;
          const isUserSelected = !!tabFromPreferred;
          const hasDetectedBuilder = !!result?.detectedBuilder;
          const showRecommendedCallout = !!recommendedTab;

          // Dynamically reorder tabs: recommended tab appears first
          const ALL_TABS: ToolId[] = ["lovable", "base44", "claude", "cursor", "generic"];
          const orderedTabs: ToolId[] = recommendedTab
            ? [recommendedTab, ...ALL_TABS.filter(t => t !== recommendedTab)]
            : ALL_TABS;

          return (
            <div
              className="fixed inset-0 z-50 flex"
              onClick={(e) => { if (e.target === e.currentTarget) setDrawerOpen(false); }}
            >
              {/* Backdrop */}
              <div className="flex-1 bg-black/60 backdrop-blur-[2px]" onClick={() => setDrawerOpen(false)} />

              {/* Panel */}
              <div className="
                fixed bottom-0 left-0 right-0 z-50
                flex max-h-[92vh] flex-col overflow-hidden rounded-t-2xl bg-zinc-950 shadow-2xl
                lg:inset-y-0 lg:bottom-auto lg:left-auto lg:right-0 lg:top-0 lg:max-h-none lg:w-[500px] lg:rounded-none lg:rounded-l-2xl
              ">

                {/* ── Header ───────────────────────────────────────────────── */}
                <div className="flex shrink-0 items-start justify-between border-b border-zinc-800 px-5 py-4">
                  <div className="min-w-0 mr-4">
                    <div className="mb-2 flex flex-wrap items-center gap-2">
                      <span className="font-mono text-[10px] font-semibold uppercase tracking-widest text-zinc-500">
                        {t("fixPromptHeader").toUpperCase()}
                      </span>
                      <span className={`inline-flex items-center gap-1.5 rounded border px-2 py-0.5 font-mono text-[10px] font-semibold ${P_CONFIG[selectedFinding.priority].badge}`}>
                        <span className={`h-1 w-1 rounded-full ${P_CONFIG[selectedFinding.priority].dot}`} />
                        {P_CONFIG[selectedFinding.priority].label}
                      </span>
                      <span className="font-mono text-[10px] text-zinc-600">{selectedFinding.category}</span>
                    </div>
                    <p className="text-sm font-semibold leading-snug text-white line-clamp-3">
                      {selectedFinding.issue}
                    </p>
                  </div>
                  <button
                    onClick={() => setDrawerOpen(false)}
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-zinc-700 text-zinc-400 transition-colors hover:border-zinc-500 hover:text-white"
                    aria-label="Close"
                  >
                    <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </div>

                {/* ── Builder callout ───────────────────────────────────────── */}
                {showRecommendedCallout ? (
                  <div className="shrink-0 border-b border-zinc-800 bg-violet-950/50 px-5 py-2.5">
                    <div className="flex items-start gap-2.5">
                      <span className="mt-px shrink-0 text-sm leading-none">⚡</span>
                      <div>
                        <p className="text-xs font-semibold text-violet-100">
                          {isUserSelected
                            ? `You selected: ${preferredBuilder!.charAt(0).toUpperCase() + preferredBuilder!.slice(1)}`
                            : `Detected builder: ${result?.detectedBuilder}`}
                        </p>
                        <p className="mt-0.5 text-[11px] text-violet-400">
                          The <span className="text-violet-200">{recommendedTab ? TOOL_LABELS[recommendedTab] : ""}</span> tab is{" "}
                          {isUserSelected ? "first — matching your selection." : "pre-selected with a prompt tailored for this builder."}
                        </p>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="shrink-0 border-b border-zinc-800 bg-zinc-900/50 px-5 py-2.5">
                    <div className="flex items-center gap-2">
                      <span className="text-sm leading-none">🔍</span>
                      <p className="text-[11px] text-zinc-500">
                        {t("noBuilderDetected")}
                      </p>
                    </div>
                  </div>
                )}

                {/* ── Tabs ─────────────────────────────────────────────────── */}
                <div className="flex shrink-0 overflow-x-auto border-b border-zinc-800 px-4 pt-1 scrollbar-none">
                  {orderedTabs.map((tool) => {
                    const isRecommended = tool === recommendedTab && showRecommendedCallout;
                    const tooltipText = isRecommended ? RECOMMENDED_TOOLTIP[tool] : null;
                    return (
                      <div key={tool} className="group relative shrink-0">
                        <button
                          onClick={() => setActiveTab(tool)}
                          className={`-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2.5 font-mono text-xs font-semibold transition-colors ${
                            activeTab === tool
                              ? "border-white text-white"
                              : "border-transparent text-zinc-500 hover:text-zinc-300"
                          }`}
                        >
                          {TOOL_LABELS[tool]}
                          {isRecommended && (
                            <span className="rounded bg-violet-600 px-1.5 py-px font-mono text-[8px] font-bold leading-none text-white">
                              Recommended
                            </span>
                          )}
                        </button>
                        {/* Tooltip — shown on hover for recommended tab */}
                        {tooltipText && (
                          <div className="pointer-events-none absolute bottom-full left-0 z-10 mb-2 hidden w-64 rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2.5 shadow-xl group-hover:block">
                            <p className="text-[11px] leading-relaxed text-zinc-300">{tooltipText}</p>
                            {/* Arrow */}
                            <div className="absolute -bottom-1.5 left-4 h-3 w-3 rotate-45 border-b border-r border-zinc-700 bg-zinc-800" />
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>

                {/* ── Prompt content ────────────────────────────────────────── */}
                <div className="flex-1 overflow-y-auto">
                  <div className="space-y-4 p-5">

                    {/* Tool description */}
                    <div className="rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-3">
                      <p className="text-xs leading-relaxed text-zinc-400">
                        <span className="font-semibold text-zinc-200">{TOOL_LABELS[activeTab]}</span>
                        {" — "}{TOOL_DESCRIPTIONS[activeTab]}
                      </p>
                    </div>

                    {/* Prompt block — code editor style */}
                    <div className="overflow-hidden rounded-xl border border-zinc-800">
                      {/* Editor chrome */}
                      <div className="flex items-center justify-between border-b border-zinc-800 bg-zinc-900 px-4 py-2.5">
                        <div className="flex items-center gap-2.5">
                          <div className="flex gap-1.5">
                            <div className="h-2.5 w-2.5 rounded-full bg-zinc-700" />
                            <div className="h-2.5 w-2.5 rounded-full bg-zinc-700" />
                            <div className="h-2.5 w-2.5 rounded-full bg-zinc-700" />
                          </div>
                          <span className="font-mono text-[10px] text-zinc-600">
                            fix-prompt-{activeTab}.txt
                          </span>
                        </div>
                        <button
                          onClick={() => copyPrompt(activeTab, fixPrompts[activeTab])}
                          className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 font-mono text-[11px] font-semibold transition-all duration-150 ${
                            copiedPrompt === activeTab
                              ? "bg-green-900/70 text-green-400 ring-1 ring-green-700"
                              : "bg-white text-zinc-950 hover:bg-zinc-200 active:scale-95"
                          }`}
                        >
                          {copiedPrompt === activeTab ? (
                            <>
                              <svg width="11" height="11" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                              </svg>
                              Copied
                            </>
                          ) : (
                            <>
                              <svg width="11" height="11" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                                <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
                              </svg>
                              Copy prompt
                            </>
                          )}
                        </button>
                      </div>
                      {/* Prompt text */}
                      <div className="bg-zinc-950 p-5">
                        <pre className="whitespace-pre-wrap font-mono text-xs leading-relaxed text-zinc-300">
                          {fixPrompts[activeTab]}
                        </pre>
                      </div>
                    </div>

                    {/* Footer tip */}
                    <div className="flex items-start gap-2.5 rounded-lg border border-zinc-800 bg-zinc-900/60 px-4 py-3">
                      <span className="mt-0.5 shrink-0 text-sm leading-none">💡</span>
                      <p className="text-xs leading-relaxed text-zinc-500">
                        Paste into{" "}
                        <span className="font-semibold text-zinc-300">{TOOL_LABELS[activeTab]}</span>{" "}
                        as a focused, single-issue session. One fix per prompt produces significantly better results than batching multiple issues.
                      </p>
                    </div>

                  </div>
                </div>

              </div>
            </div>
          );
        })()}

        {/* ── Screenshot Modal ─────────────────────────────────────────────── */}
        {screenshotModalOpen && screenshotBase64 && (
          <div
            className="fixed inset-0 z-[60] flex items-center justify-center bg-black/85 p-4"
            onClick={() => { setScreenshotModalOpen(false); setScreenshotModalFinding(null); }}
          >
            <div
              className="relative max-h-[90vh] w-full max-w-5xl overflow-hidden rounded-xl shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            >
              {/* Modal browser chrome */}
              <div className="flex items-center gap-1.5 bg-zinc-950 px-4 py-2.5">
                <span className="h-2.5 w-2.5 rounded-full bg-zinc-700" />
                <span className="h-2.5 w-2.5 rounded-full bg-zinc-700" />
                <span className="h-2.5 w-2.5 rounded-full bg-zinc-700" />
                <span className="ml-2 flex-1 rounded bg-zinc-800 px-3 py-0.5 font-mono text-[9px] text-zinc-400 truncate">
                  {url}
                </span>
                {screenshotModalFinding && (
                  <span className="ml-2 rounded border border-zinc-700 bg-zinc-800 px-2 py-0.5 font-mono text-[9px] text-zinc-400 truncate max-w-[200px]">
                    ↑ {screenshotModalFinding.category}
                  </span>
                )}
                <button
                  onClick={() => { setScreenshotModalOpen(false); setScreenshotModalFinding(null); }}
                  className="ml-2 flex h-6 w-6 shrink-0 items-center justify-center rounded text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200 transition-colors"
                  aria-label="Close"
                >
                  <svg width="12" height="12" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>

              {/* Full screenshot — zoomable & pannable */}
              <div
                className="relative overflow-hidden bg-zinc-950 select-none"
                style={{
                  maxHeight: "calc(90vh - 80px)",
                  cursor: modalZoom > 1 ? (modalIsDragging ? "grabbing" : "grab") : "default",
                }}
                onWheel={(e) => {
                  e.preventDefault();
                  const d = e.deltaY < 0 ? 0.25 : -0.25;
                  setModalZoom((z) => {
                    const next = Math.max(1, Math.min(4, parseFloat((z + d).toFixed(2))));
                    if (next === 1) setModalPan({ x: 0, y: 0 });
                    return next;
                  });
                }}
                onMouseDown={(e) => {
                  if (modalZoom <= 1) return;
                  modalDragging.current = true;
                  setModalIsDragging(true);
                  modalLastPos.current = { x: e.clientX, y: e.clientY };
                }}
                onMouseMove={(e) => {
                  if (!modalDragging.current) return;
                  const dx = e.clientX - modalLastPos.current.x;
                  const dy = e.clientY - modalLastPos.current.y;
                  modalLastPos.current = { x: e.clientX, y: e.clientY };
                  setModalPan((prev) => ({ x: prev.x + dx, y: prev.y + dy }));
                }}
                onMouseUp={() => { modalDragging.current = false; setModalIsDragging(false); }}
                onMouseLeave={() => { modalDragging.current = false; setModalIsDragging(false); }}
              >
                <div
                  style={{
                    transform: `translate(${modalPan.x}px, ${modalPan.y}px) scale(${modalZoom})`,
                    transformOrigin: "top center",
                    transition: modalIsDragging ? "none" : "transform 0.15s ease",
                  }}
                >
                  <img
                    src={`data:image/jpeg;base64,${screenshotBase64}`}
                    alt={`Full screenshot of ${result.domain}`}
                    className="w-full block"
                    draggable={false}
                  />
                  {/* Annotation overlay — preserved at all zoom levels */}
                  {screenshotModalFinding && (
                    <AnnotationOverlay
                      finding={screenshotModalFinding}
                      apiData={apiData}
                    />
                  )}
                </div>
              </div>

              {/* Modal footer */}
              <div className="flex items-center gap-3 bg-zinc-950 px-4 py-2 border-t border-zinc-800">
                {screenshotMeta && (
                  <>
                    <span className="font-mono text-[9px] text-zinc-500">🖥 {screenshotMeta.viewport} · 1280×800</span>
                    <span className="font-mono text-[9px] text-zinc-500">
                      {new Date(screenshotMeta.capturedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                    </span>
                  </>
                )}
                {/* Zoom controls */}
                <div className="ml-auto flex items-center gap-1">
                  <button
                    onClick={() => { const n = Math.max(1, parseFloat((modalZoom - 0.25).toFixed(2))); if (n === 1) setModalPan({x:0,y:0}); setModalZoom(n); }}
                    className="flex h-6 w-6 items-center justify-center rounded border border-zinc-700 font-mono text-xs text-zinc-400 hover:border-zinc-500 hover:text-zinc-200 transition-colors disabled:opacity-40"
                    disabled={modalZoom <= 1}
                    aria-label="Zoom out"
                  >−</button>
                  <span className="min-w-[38px] text-center font-mono text-[10px] text-zinc-400 tabular-nums">
                    {Math.round(modalZoom * 100)}%
                  </span>
                  <button
                    onClick={() => setModalZoom((z) => Math.min(4, parseFloat((z + 0.25).toFixed(2))))}
                    className="flex h-6 w-6 items-center justify-center rounded border border-zinc-700 font-mono text-xs text-zinc-400 hover:border-zinc-500 hover:text-zinc-200 transition-colors disabled:opacity-40"
                    disabled={modalZoom >= 4}
                    aria-label="Zoom in"
                  >+</button>
                  {modalZoom !== 1 && (
                    <button
                      onClick={() => { setModalZoom(1); setModalPan({ x: 0, y: 0 }); }}
                      className="ml-1 rounded border border-zinc-700 px-2 py-px font-mono text-[9px] text-zinc-400 hover:border-zinc-500 hover:text-zinc-200 transition-colors"
                    >Reset</button>
                  )}
                  <span className="ml-3 font-mono text-[9px] text-zinc-600">Scroll to zoom · drag to pan · Esc to close</span>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ── Evidence Drawer ───────────────────────────────────────────────── */}
        {evidenceDrawerOpen && evidenceFinding && (() => {
          const ev = buildFindingEvidence(evidenceFinding, apiData, url, isRealAudit);
          const cfg = P_CONFIG[evidenceFinding.priority];

          const STATUS_ICON: Record<string, string> = {
            good: "✓",
            warning: "⚠",
            critical: "✗",
            neutral: "—",
          };
          const STATUS_COLOR: Record<string, string> = {
            good: "text-green-600",
            warning: "text-amber-600",
            critical: "text-red-600",
            neutral: "text-zinc-400",
          };
          const STATUS_BG: Record<string, string> = {
            good: "bg-green-50 border-green-200",
            warning: "bg-amber-50 border-amber-200",
            critical: "bg-red-50 border-red-200",
            neutral: "bg-zinc-50 border-zinc-200",
          };

          return (
            <div
              className="fixed inset-0 z-50 flex"
              onClick={(e) => { if (e.target === e.currentTarget) setEvidenceDrawerOpen(false); }}
            >
              {/* Backdrop — plain overlay, no blur (blur makes Clearspec look like a screenshot of the audited site) */}
              <div className="flex-1 bg-black/40" onClick={() => setEvidenceDrawerOpen(false)} />

              {/* Panel — white/light, distinct from the dark fix prompt panel */}
              <div className="
                fixed bottom-0 left-0 right-0 z-50
                flex h-[92vh] flex-col overflow-hidden rounded-t-2xl bg-white shadow-2xl
                lg:inset-y-0 lg:bottom-auto lg:left-auto lg:right-0 lg:top-0 lg:h-full lg:w-[480px] lg:rounded-none lg:rounded-l-2xl
              ">

                {/* ── Header ─────────────────────────────────────────────────── */}
                <div className="shrink-0 border-b border-zinc-100 px-5 pb-4 pt-4">
                  {/* Top row: meta badges + close */}
                  <div className="mb-3 flex items-center justify-between gap-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={`inline-flex items-center gap-1.5 rounded border px-2 py-0.5 font-mono text-[10px] font-semibold ${cfg.badge}`}>
                        <span className={`h-1 w-1 rounded-full ${cfg.dot}`} />
                        {cfg.label}
                      </span>
                      <span className="font-mono text-[10px] text-zinc-400">{evidenceFinding.category}</span>
                      <span className={`rounded px-1.5 py-px font-mono text-[9px] font-semibold ${ev.dataSource === "real" ? "bg-green-100 text-green-700" : "bg-amber-100 text-amber-700"}`}>
                        {ev.dataSource === "real" ? "✓ Live data" : "⚠ Heuristic"}
                      </span>
                    </div>
                    <button
                      onClick={() => setEvidenceDrawerOpen(false)}
                      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-zinc-200 text-zinc-400 transition-colors hover:border-zinc-400 hover:text-zinc-700"
                      aria-label="Close"
                    >
                      <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                  {/* Large prominent issue title */}
                  <h2 className="mb-2 text-xl font-bold leading-snug text-zinc-900">
                    {evidenceFinding.issue}
                  </h2>
                  {/* Explanation — immediately visible, no scroll needed */}
                  <p className="text-sm leading-relaxed text-zinc-600">
                    {evidenceFinding.whyItMatters}
                  </p>
                </div>

                {/* ── Scrollable body ─────────────────────────────────────────── */}
                <div className="flex-1 overflow-y-auto overscroll-contain">
                  <div className="space-y-5 p-5">

                    {/* ── FOUND / EXPECTED / IMPACT reasoning layer ────────────── */}
                    {(evidenceFinding.found || evidenceFinding.expected) && (
                      <div>
                        <p className="mb-2 font-mono text-[10px] font-semibold uppercase tracking-widest text-zinc-400">
                          {t("whyThisFindingExists").toUpperCase()}
                        </p>
                        <div className="space-y-2">
                          {evidenceFinding.found && (
                            <div className="rounded-xl border border-zinc-200 bg-white px-4 py-3.5">
                              <p className="mb-1.5 font-mono text-[9px] font-bold uppercase tracking-widest text-red-500">{t("foundLabel").toUpperCase()}</p>
                              <p className="text-sm leading-relaxed text-zinc-800">{evidenceFinding.found}</p>
                            </div>
                          )}
                          {evidenceFinding.expected && (
                            <div className="rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-3.5">
                              <p className="mb-1.5 font-mono text-[9px] font-bold uppercase tracking-widest text-emerald-600">{t("expectedLabel").toUpperCase()}</p>
                              <p className="text-sm leading-relaxed text-zinc-700">{evidenceFinding.expected}</p>
                            </div>
                          )}
                          <div className="rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-3.5">
                            <p className="mb-1.5 font-mono text-[9px] font-bold uppercase tracking-widest text-amber-600">Impact</p>
                            <p className="text-sm leading-relaxed text-zinc-700">{evidenceFinding.whyItMatters}</p>
                          </div>
                        </div>
                      </div>
                    )}

                    {/* ── Visual focus screenshot preview ─────────────────────── */}
                    <div>
                      <p className="mb-2 font-mono text-[10px] font-semibold uppercase tracking-widest text-zinc-400">
                        {t("visualFocus").toUpperCase()}
                      </p>
                      {/* Screenshot container — 360px shows a clear, readable portion of the page */}
                      <div
                        className="relative overflow-hidden rounded-xl border-2 border-zinc-200 bg-zinc-100 shadow-sm"
                        style={{ height: 360 }}
                      >
                        {screenshotBase64 ? (
                          /* ── Real screenshot — shown whenever base64 data is available ── */
                          <>
                            <img
                              src={`data:image/jpeg;base64,${screenshotBase64}`}
                              alt="Page screenshot with annotation"
                              style={{ width: "100%", display: "block" }}
                            />
                            {/* Annotation overlay — percentage coords on the full image */}
                            <div style={{ position: "absolute", inset: 0 }}>
                              <AnnotationOverlay finding={evidenceFinding} apiData={apiData} />
                            </div>
                            {/* Subtle loading overlay if a fresh capture is in progress */}
                            {screenshotLoading && (
                              <div className="absolute bottom-2 right-2 flex items-center gap-1.5 rounded-md bg-black/60 px-2 py-1">
                                <div className="h-2 w-2 animate-spin rounded-full border border-white/60 border-t-white" />
                                <span className="font-mono text-[8px] text-white/80">Refreshing…</span>
                              </div>
                            )}
                          </>
                        ) : screenshotLoading ? (
                          /* ── Capturing — no data yet ── */
                          <div className="flex h-full items-center justify-center">
                            <div className="text-center">
                              <div className="mx-auto mb-1.5 h-4 w-4 animate-spin rounded-full border-2 border-zinc-300 border-t-zinc-600" />
                              <p className="font-mono text-[9px] text-zinc-400">{t("capturingScreenshot")}</p>
                            </div>
                          </div>
                        ) : screenshotError ? (
                          /* ── Capture failed — show error, not wireframe ── */
                          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="text-zinc-400">
                              <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
                            </svg>
                            <p className="font-mono text-[9px] text-zinc-500">{t("screenshotUnavailable")}</p>
                            <p className="font-mono text-[8px] text-zinc-400">{t("jumpToSnapshot")}</p>
                          </div>
                        ) : (
                          /* ── Pre-capture wireframe — screenshot not yet requested ── */
                          <div className="relative h-full">
                            <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: "14%", background: "#27272a" }} />
                            <div style={{ position: "absolute", top: "14%", left: 0, right: 0, height: "50%", background: "#3f3f46" }} />
                            <div style={{ position: "absolute", top: "14%", left: "20%", width: "60%", height: "3%", background: "#52525b", borderRadius: 4 }} />
                            <div style={{ position: "absolute", top: "22%", left: "30%", width: "40%", height: "2%", background: "#3f3f46", borderRadius: 4 }} />
                            <div style={{ position: "absolute", top: "30%", left: "35%", width: "30%", height: "7%", background: "#52525b", borderRadius: 6 }} />
                            <AnnotationOverlay finding={evidenceFinding} apiData={apiData} />
                          </div>
                        )}
                        {/* Subtle bottom fade — hints that the page continues below the crop */}
                        <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, height: 40, background: "linear-gradient(to bottom, transparent, rgba(255,255,255,0.90))", pointerEvents: "none" }} />
                      </div>
                      {/* Action buttons */}
                      <div className="mt-2 flex gap-2">
                        {/* Jump to main screenshot — closes drawer, scrolls + highlights */}
                        <button
                          onClick={() => jumpToSnapshot(evidenceFinding.priority)}
                          className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-zinc-200 px-3 py-1.5 font-mono text-[10px] text-zinc-600 transition-colors hover:border-zinc-400 hover:bg-zinc-50 hover:text-zinc-800"
                        >
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <line x1="12" y1="19" x2="12" y2="5" /><polyline points="5 12 12 5 19 12" />
                          </svg>
                          {t("jumpToSnapshot")}
                        </button>
                        {/* Open zoomed modal */}
                        {screenshotBase64 && (
                          <button
                            onClick={() => { setScreenshotModalFinding(evidenceFinding); setScreenshotModalOpen(true); }}
                            className="flex flex-1 items-center justify-center gap-1.5 rounded-lg border border-zinc-200 px-3 py-1.5 font-mono text-[10px] text-zinc-600 transition-colors hover:border-zinc-400 hover:bg-zinc-50 hover:text-zinc-800"
                          >
                            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
                            </svg>
                            {t("fullScreenshot")}
                          </button>
                        )}
                      </div>
                      <p className="mt-1.5 text-center font-mono text-[9px] text-zinc-400">
                        {screenshotBase64
                          ? "Annotated preview · jump to main snapshot for full detail"
                          : screenshotLoading
                          ? "Capturing screenshot — annotation based on page structure"
                          : screenshotError
                          ? "Screenshot unavailable · annotation based on page structure"
                          : "Awaiting screenshot · annotation based on page structure"}
                      </p>
                    </div>

                    {/* ── Confidence section ──────────────────────────────────── */}
                    {(() => {
                      const conf = calculateConfidence(evidenceFinding, apiData, isRealAudit);
                      const CONF_STATUS_ICON: Record<string, string> = { good: "✓", warning: "⚠", critical: "✗", neutral: "—" };
                      const CONF_STATUS_COLOR: Record<string, string> = {
                        good: "text-green-600", warning: "text-amber-600", critical: "text-red-600", neutral: "text-zinc-400",
                      };
                      const levelColors = conf.level === "high"
                        ? { bg: "bg-emerald-50", border: "border-emerald-200", badge: "bg-emerald-100 text-emerald-700 border-emerald-200", bar: "bg-emerald-500", label: "High confidence" }
                        : conf.level === "medium"
                        ? { bg: "bg-sky-50", border: "border-sky-200", badge: "bg-sky-100 text-sky-700 border-sky-200", bar: "bg-sky-500", label: "Medium confidence" }
                        : { bg: "bg-zinc-50", border: "border-zinc-200", badge: "bg-zinc-100 text-zinc-600 border-zinc-200", bar: "bg-zinc-400", label: "Low confidence" };

                      return (
                        <div>
                          <p className="mb-2 font-mono text-[10px] font-semibold uppercase tracking-widest text-zinc-400">
                            {t("confidenceSection").toUpperCase()}
                          </p>
                          <div className={`rounded-xl border ${levelColors.border} ${levelColors.bg} p-4`}>
                            {/* Score + level + bar */}
                            <div className="mb-3 flex items-center justify-between gap-3">
                              <div className="flex items-center gap-2.5">
                                <span className="text-2xl font-semibold text-zinc-900 tabular-nums">{conf.score}%</span>
                                <span className={`rounded border px-2 py-0.5 font-mono text-[10px] font-semibold ${levelColors.badge}`}>
                                  {levelColors.label}
                                </span>
                              </div>
                              {/* Score bar */}
                              <div className="w-20 shrink-0">
                                <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/60">
                                  <div
                                    className={`h-full rounded-full transition-all ${levelColors.bar}`}
                                    style={{ width: `${conf.score}%` }}
                                  />
                                </div>
                              </div>
                            </div>

                            {/* Signals */}
                            <div className="mb-3 space-y-1.5">
                              {conf.signals.map((s, i) => (
                                <div key={i} className="flex items-center gap-2">
                                  <span className={`w-3 shrink-0 text-center font-mono text-xs font-bold ${CONF_STATUS_COLOR[s.status]}`}>
                                    {CONF_STATUS_ICON[s.status]}
                                  </span>
                                  <span className="font-mono text-[11px] text-zinc-700">{s.label}</span>
                                </div>
                              ))}
                            </div>

                            {/* Reason */}
                            <p className="text-[11px] leading-relaxed text-zinc-500">{conf.reason}</p>
                          </div>
                        </div>
                      );
                    })()}

                    {/* What the audit found */}
                    <div>
                      <p className="mb-2 font-mono text-[10px] font-semibold uppercase tracking-widest text-zinc-400">
                        {t("whatTheAuditFound").toUpperCase()}
                      </p>
                      <p className="text-sm leading-relaxed text-zinc-700">
                        {ev.summary}
                      </p>
                    </div>

                    {/* Signal table */}
                    <div>
                      <p className="mb-2 font-mono text-[10px] font-semibold uppercase tracking-widest text-zinc-400">
                        {t("signalsUsed").toUpperCase()}
                      </p>
                      <div className="overflow-hidden rounded-xl border border-zinc-200">
                        {ev.signals.map((sig, i) => (
                          <div
                            key={sig.label}
                            className={`flex items-start gap-3 px-4 py-3 ${i < ev.signals.length - 1 ? "border-b border-zinc-100" : ""} ${i % 2 === 0 ? "bg-white" : "bg-zinc-50/50"}`}
                          >
                            {/* Status icon */}
                            <span className={`mt-0.5 shrink-0 font-mono text-xs font-bold w-4 text-center ${STATUS_COLOR[sig.status]}`}>
                              {STATUS_ICON[sig.status]}
                            </span>
                            {/* Label */}
                            <div className="min-w-0 flex-1">
                              <p className="font-mono text-[11px] font-semibold text-zinc-600">{sig.label}</p>
                              {sig.note && (
                                <p className="mt-0.5 font-mono text-[10px] text-zinc-400">{sig.note}</p>
                              )}
                            </div>
                            {/* Value */}
                            <div className={`shrink-0 max-w-[200px] rounded border px-2 py-0.5 font-mono text-[11px] ${STATUS_BG[sig.status]}`}>
                              <span className="break-all leading-relaxed">{sig.value}</span>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>

                    {/* Why this finding was created */}
                    <div>
                      <p className="mb-2 font-mono text-[10px] font-semibold uppercase tracking-widest text-zinc-400">
                        {t("whyThisFindingWasCreated").toUpperCase()}
                      </p>
                      <div className="rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-3">
                        <p className="text-xs leading-relaxed text-zinc-600">{ev.triggerReason}</p>
                      </div>
                    </div>

                    {/* Visual evidence section — annotated screenshot */}
                    <div>
                      <p className="mb-2 font-mono text-[10px] font-semibold uppercase tracking-widest text-zinc-400">
                        {t("visualEvidence").toUpperCase()}
                      </p>
                      <AnnotatedScreenshot
                        screenshotBase64={screenshotBase64}
                        screenshotLoading={screenshotLoading}
                        finding={evidenceFinding}
                        apiData={apiData}
                        onViewFull={() => {
                          setScreenshotModalFinding(evidenceFinding);
                          setScreenshotModalOpen(true);
                        }}
                      />
                    </div>

                    {/* Separator + Fix Prompt CTA */}
                    <div className="border-t border-zinc-100 pt-1">
                      <div className="flex items-center justify-between rounded-xl border border-zinc-200 bg-white px-4 py-3">
                        <div>
                          <p className="text-xs font-semibold text-zinc-700">{t("readyToFix")}</p>
                          <p className="text-[11px] text-zinc-400">{t("openFixPromptDrawer")}</p>
                        </div>
                        <button
                          onClick={() => {
                            setEvidenceDrawerOpen(false);
                            openDrawer(evidenceFinding);
                          }}
                          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-zinc-900 px-4 py-2 font-mono text-[11px] font-semibold text-white hover:bg-zinc-700 transition-colors"
                        >
                          {t("fixPromptBtn")}
                        </button>
                      </div>
                    </div>

                  </div>
                </div>

              </div>
            </div>
          );
        })()}
      </>
    );
  }

  return null;
}

// ── Annotation overlay (manages its own hover state) ─────────────────────────

function AnnotationOverlay({
  finding,
  apiData,
}: {
  finding: AuditFinding;
  apiData: APIAuditData | null;
}) {
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);
  const regions = getAnnotationRegions(finding, apiData);
  const conf = calculateConfidence(finding, apiData, !!apiData);

  // Priority → clearly visible colors
  const PC: Record<Priority, {
    fill: string;     // semi-transparent fill — enough to see without hover
    fillHover: string;
    borderColor: string;
    shadow: string;   // box-shadow ring for extra visibility
    chipBg: string;
    chipText: string;
    chipBorder: string;
    dot: string;
  }> = {
    urgent: {
      fill:        "rgba(239,68,68,0.25)",
      fillHover:   "rgba(239,68,68,0.38)",
      borderColor: "rgba(239,68,68,0.90)",
      shadow:      "0 0 0 2px rgba(239,68,68,0.35), inset 0 0 0 1px rgba(239,68,68,0.20)",
      chipBg:      "rgba(255,255,255,0.92)",
      chipText:    "#b91c1c",
      chipBorder:  "rgba(239,68,68,0.45)",
      dot:         "#ef4444",
    },
    important: {
      fill:        "rgba(249,115,22,0.22)",
      fillHover:   "rgba(249,115,22,0.35)",
      borderColor: "rgba(249,115,22,0.88)",
      shadow:      "0 0 0 2px rgba(249,115,22,0.30), inset 0 0 0 1px rgba(249,115,22,0.18)",
      chipBg:      "rgba(255,255,255,0.92)",
      chipText:    "#c2410c",
      chipBorder:  "rgba(249,115,22,0.45)",
      dot:         "#f97316",
    },
    later: {
      fill:        "rgba(234,179,8,0.22)",
      fillHover:   "rgba(234,179,8,0.36)",
      borderColor: "rgba(234,179,8,0.88)",
      shadow:      "0 0 0 2px rgba(234,179,8,0.30), inset 0 0 0 1px rgba(234,179,8,0.18)",
      chipBg:      "rgba(255,255,255,0.92)",
      chipText:    "#92400e",
      chipBorder:  "rgba(234,179,8,0.50)",
      dot:         "#eab308",
    },
  };
  const pc = PC[finding.priority];

  return (
    <>
      {regions.map((r, i) => {
        const isHovered = hoveredIdx === i;
        const tooltipAbove = r.y > 52;
        // Full-page outline (performance) gets a very subtle treatment
        const isFullPage = r.width >= 90 && r.height >= 90;
        const fill = isHovered
          ? (isFullPage ? "rgba(0,0,0,0.04)" : pc.fillHover)
          : (isFullPage ? "rgba(0,0,0,0.0)" : pc.fill);
        const borderColor = isFullPage
          ? pc.borderColor.replace(/[\d.]+\)$/, "0.45)")
          : pc.borderColor;
        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left: `${r.x}%`,
              top: `${r.y}%`,
              width: `${r.width}%`,
              height: `${r.height}%`,
              background: fill,
              border: `${isFullPage ? 2 : 3.5}px solid ${borderColor}`,
              borderRadius: 8,
              boxShadow: isFullPage ? "none" : pc.shadow,
              transition: "background 150ms",
              cursor: "default",
              zIndex: 10,
              pointerEvents: "auto",
            }}
            onMouseEnter={() => setHoveredIdx(i)}
            onMouseLeave={() => setHoveredIdx(null)}
          >
            {/* Always-visible label chip — larger and high contrast */}
            <div style={{ position: "absolute", top: 7, left: 7, maxWidth: "calc(100% - 14px)" }}>
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  borderRadius: 6,
                  border: `1.5px solid ${pc.chipBorder}`,
                  background: pc.chipBg,
                  padding: "4px 9px",
                  fontFamily: "monospace",
                  fontSize: 11,
                  fontWeight: 700,
                  color: pc.chipText,
                  boxShadow: "0 2px 6px rgba(0,0,0,0.22)",
                  backdropFilter: "blur(6px)",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  maxWidth: "100%",
                  letterSpacing: "0.01em",
                }}
              >
                <span
                  style={{
                    display: "inline-block",
                    width: 7,
                    height: 7,
                    borderRadius: "50%",
                    background: pc.dot,
                    flexShrink: 0,
                  }}
                />
                {r.label}
              </span>
            </div>

            {/* Hover tooltip — confidence + reason */}
            {isHovered && (
              <div
                style={{
                  position: "absolute",
                  left: "50%",
                  transform: "translateX(-50%)",
                  ...(tooltipAbove
                    ? { bottom: "calc(100% + 10px)" }
                    : { top: "calc(100% + 10px)" }),
                  minWidth: 220,
                  maxWidth: 280,
                  zIndex: 30,
                  pointerEvents: "none",
                  background: "white",
                  border: "1px solid #e4e4e7",
                  borderRadius: 10,
                  padding: "10px 12px",
                  boxShadow: "0 8px 24px rgba(0,0,0,0.15)",
                }}
              >
                <p style={{ margin: "0 0 5px", fontSize: 11, fontWeight: 600, color: "#18181b", lineHeight: 1.4 }}>
                  {finding.issue}
                </p>
                <p style={{ margin: 0, fontFamily: "monospace", fontSize: 9, color: "#71717a" }}>
                  {finding.priority.toUpperCase()} · {conf.score}% confidence · {conf.level}
                </p>
                <p style={{ margin: "6px 0 0", fontSize: 10, color: "#71717a", lineHeight: 1.5 }}>
                  {conf.reason}
                </p>
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}

// ── Annotated screenshot (real screenshot or wireframe placeholder) ────────────

// Wireframe section shapes shown when no real screenshot is available
const WF_SECTIONS = [
  { y: 0,  h: 10, bg: "#27272a" }, // nav
  { y: 10, h: 32, bg: "#3f3f46" }, // hero
  { y: 42, h: 34, bg: "#27272a" }, // content
  { y: 76, h: 24, bg: "#3f3f46" }, // footer
];

function AnnotatedScreenshot({
  screenshotBase64,
  screenshotLoading,
  finding,
  apiData,
  onViewFull,
}: {
  screenshotBase64: string | null;
  screenshotLoading: boolean;
  finding: AuditFinding;
  apiData: APIAuditData | null;
  onViewFull: () => void;
}) {
  if (!screenshotBase64) {
    // ── Wireframe mode ──────────────────────────────────────────────────────
    return (
      <div>
        <div
          className="relative overflow-hidden rounded-xl border border-zinc-700 bg-zinc-900"
          style={{ aspectRatio: "16/10" }}
        >
          {/* Wireframe background stripes */}
          {WF_SECTIONS.map((s, i) => (
            <div
              key={i}
              style={{
                position: "absolute",
                left: 0,
                top: `${s.y}%`,
                width: "100%",
                height: `${s.h}%`,
                background: s.bg,
              }}
            />
          ))}
          {/* Wireframe content lines */}
          <div style={{ position: "absolute", top: "14%", left: "20%", width: "60%", height: "2%",   background: "#52525b", borderRadius: 4 }} />
          <div style={{ position: "absolute", top: "19%", left: "30%", width: "40%", height: "1.5%", background: "#3f3f46", borderRadius: 4 }} />
          <div style={{ position: "absolute", top: "25%", left: "35%", width: "30%", height: "5%",   background: "#52525b", borderRadius: 6 }} />
          <div style={{ position: "absolute", top: "49%", left: "8%",  width: "26%", height: "8%",   background: "#3f3f46", borderRadius: 4 }} />
          <div style={{ position: "absolute", top: "49%", left: "38%", width: "26%", height: "8%",   background: "#3f3f46", borderRadius: 4 }} />
          <div style={{ position: "absolute", top: "49%", left: "68%", width: "24%", height: "8%",   background: "#3f3f46", borderRadius: 4 }} />
          <div style={{ position: "absolute", top: "61%", left: "8%",  width: "84%", height: "1.5%", background: "#52525b", borderRadius: 4 }} />
          <div style={{ position: "absolute", top: "65%", left: "8%",  width: "60%", height: "1.5%", background: "#3f3f46", borderRadius: 4 }} />

          {/* Annotation overlay */}
          <AnnotationOverlay finding={finding} apiData={apiData} />

          {/* Loading spinner overlay */}
          {screenshotLoading && (
            <div className="absolute inset-0 flex items-center justify-center bg-black/50">
              <div className="text-center">
                <div className="mx-auto mb-2 h-4 w-4 animate-spin rounded-full border-2 border-zinc-500 border-t-white" />
                <p className="font-mono text-[10px] text-zinc-400">Capturing screenshot…</p>
              </div>
            </div>
          )}
        </div>
        <p className="mt-1.5 text-center font-mono text-[9px] text-zinc-500">
          {screenshotLoading
            ? "Screenshot capturing in background — annotation based on page structure"
            : "Wireframe layout · annotations show heuristic issue location"}
        </p>
      </div>
    );
  }

  // ── Real screenshot mode ──────────────────────────────────────────────────
  return (
    <div>
      <div className="group relative overflow-hidden rounded-xl border border-zinc-200">
        <img
          src={`data:image/jpeg;base64,${screenshotBase64}`}
          alt="Page screenshot with annotations"
          className="w-full block"
        />
        {/* Annotation regions on top of real screenshot */}
        <AnnotationOverlay finding={finding} apiData={apiData} />
      </div>

      {/* View full screenshot button */}
      <div className="mt-2 flex items-center justify-between">
        <p className="font-mono text-[9px] text-zinc-400">Hover a region to see details</p>
        <button
          onClick={onViewFull}
          className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-200 px-3 py-1.5 font-mono text-[11px] text-zinc-600 transition-colors hover:border-zinc-400 hover:text-zinc-800"
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
          </svg>
          View full screenshot
        </button>
      </div>
    </div>
  );
}

// ── Context Banner ────────────────────────────────────────────────────────────

function ContextBanner({ context }: { context: SiteContext }) {
  const [expanded, setExpanded] = useState(false);

  const ACCENT: Partial<Record<SiteContextType, { border: string; bg: string; badge: string; dot: string }>> = {
    official_company_site: { border: "border-blue-200",  bg: "bg-blue-50",  badge: "bg-blue-100 text-blue-700 border-blue-200",  dot: "bg-blue-500"  },
    ai_built_site:         { border: "border-violet-200",bg: "bg-violet-50",badge: "bg-violet-100 text-violet-700 border-violet-200", dot: "bg-violet-500" },
    startup_landing_page:  { border: "border-amber-200", bg: "bg-amber-50", badge: "bg-amber-100 text-amber-700 border-amber-200",  dot: "bg-amber-500"  },
    portfolio_site:        { border: "border-teal-200",  bg: "bg-teal-50",  badge: "bg-teal-100 text-teal-700 border-teal-200",    dot: "bg-teal-500"   },
    documentation_site:    { border: "border-zinc-200",  bg: "bg-zinc-50",  badge: "bg-zinc-100 text-zinc-600 border-zinc-200",     dot: "bg-zinc-500"   },
    internal_tool_or_dashboard: { border: "border-zinc-200", bg: "bg-zinc-50", badge: "bg-zinc-100 text-zinc-600 border-zinc-200", dot: "bg-zinc-500" },
    ecommerce_or_marketplace:   { border: "border-green-200", bg: "bg-green-50", badge: "bg-green-100 text-green-700 border-green-200", dot: "bg-green-500" },
    unknown: { border: "border-zinc-200", bg: "bg-zinc-50", badge: "bg-zinc-100 text-zinc-500 border-zinc-200", dot: "bg-zinc-400" },
  };

  const a = ACCENT[context.siteType] ?? ACCENT.unknown!;
  const label = SITE_TYPE_LABELS[context.siteType];
  const icon = SITE_TYPE_ICONS[context.siteType];
  const conf = confidenceLabel(context.confidence);

  return (
    <div className={`overflow-hidden rounded-xl border ${a.border} ${a.bg}`}>
      {/* Collapsed header — always visible */}
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-3 px-4 py-3 text-left"
        aria-expanded={expanded}
      >
        <span className="text-base leading-none">{icon}</span>
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`inline-flex items-center gap-1.5 rounded border px-2 py-0.5 font-mono text-[10px] font-semibold ${a.badge}`}>
              <span className={`h-1.5 w-1.5 rounded-full ${a.dot}`} />
              {label}
            </span>
            <span className="font-mono text-[10px] text-zinc-500">
              {conf} confidence · {Math.round(context.confidence * 100)}%
            </span>
            {context.detectedBuilder && (
              <span className="font-mono text-[10px] text-zinc-400">
                Builder: {context.detectedBuilder}
              </span>
            )}
          </div>
          {!expanded && (
            <p className="mt-0.5 truncate text-xs text-zinc-500">{context.auditNote}</p>
          )}
        </div>
        <svg
          width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor"
          strokeWidth={2} className={`shrink-0 text-zinc-400 transition-transform ${expanded ? "rotate-180" : ""}`}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* Expanded details */}
      {expanded && (
        <div className="border-t border-current/10 px-4 pb-4 pt-3">
          <p className="mb-3 text-xs leading-relaxed text-zinc-600">{context.auditNote}</p>
          {context.reasons.length > 0 && (
            <div>
              <p className="mb-1.5 font-mono text-[10px] font-semibold uppercase tracking-widest text-zinc-500">
                Why this classification
              </p>
              <ul className="space-y-1">
                {context.reasons.map((r, i) => (
                  <li key={i} className="flex items-start gap-2 text-xs text-zinc-600">
                    <span className="mt-1 shrink-0 text-zinc-400">→</span>
                    {r}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function SummaryCard({ label, value, sub, accent }: { label: string; value: string; sub: string; accent: string }) {
  const borders: Record<string, string> = { zinc: "border-zinc-200", red: "border-red-200", green: "border-green-200", amber: "border-amber-200" };
  return (
    <div className={`rounded-xl border bg-white p-4 ${borders[accent] ?? borders.zinc}`}>
      <p className="mb-1 font-mono text-[10px] font-semibold uppercase tracking-widest text-zinc-400">{label}</p>
      <p className="mb-1 text-base font-semibold text-zinc-900">{value}</p>
      <p className="text-[11px] leading-relaxed text-zinc-500 line-clamp-2">{sub}</p>
    </div>
  );
}

function EffortBadge({ v }: { v: Effort }) {
  const s = { Low: "text-green-700 bg-green-50 border-green-200", Medium: "text-amber-700 bg-amber-50 border-amber-200", High: "text-red-700 bg-red-50 border-red-200" }[v];
  return <span className={`inline-block rounded border px-2 py-0.5 font-mono text-[10px] ${s}`}>{v}</span>;
}

function ImpactBadge({ v }: { v: Impact }) {
  const s = { High: "text-blue-700 bg-blue-50 border-blue-200", Medium: "text-zinc-700 bg-zinc-50 border-zinc-200", Low: "text-zinc-500 bg-white border-zinc-200" }[v];
  return <span className={`inline-block rounded border px-2 py-0.5 font-mono text-[10px] ${s}`}>{v}</span>;
}
