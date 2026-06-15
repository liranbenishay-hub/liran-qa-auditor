/**
 * Site Context Engine
 *
 * Classifies the scanned site into a meaningful product context so the
 * audit can apply the right rules. Apple should not be penalised for a
 * short title. A Lovable prototype should be scrutinised more strictly.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type SiteContextType =
  | "official_company_site"
  | "ai_built_site"
  | "startup_landing_page"
  | "portfolio_site"
  | "internal_tool_or_dashboard"
  | "ecommerce_or_marketplace"
  | "documentation_site"
  | "unknown";

export interface SiteContext {
  siteType: SiteContextType;
  confidence: number;       // 0–1
  reasons: string[];        // top 2–3 human-readable reasons
  detectedBuilder: string | null;
  auditNote: string;        // shown in the banner to explain how audit was adjusted
  /** Factors used internally — not shown in UI */
  _signals: Record<string, boolean>;
}

/** Minimal input surface — decoupled from the API response type */
export interface SiteContextInputs {
  hostname: string;
  urlPath: string;
  title: string;
  description: string;
  h1Tags: string[];
  h2Tags: string[];
  wordCount: number;
  buttonCount: number;
  formCount: number;
  linkCount: number;
  hasPricing: boolean;
  hasSignup: boolean;
  hasContact: boolean;
  detectedBuilder: string | null;
}

// ── Known official / major brand domains ─────────────────────────────────────

/** Domains confirmed to be major companies or mature products.
 *  Root domain only (no www, no subdomain, no path). */
const KNOWN_OFFICIAL_DOMAINS = new Set([
  // Big tech
  "apple.com", "google.com", "microsoft.com", "amazon.com", "meta.com",
  "facebook.com", "instagram.com", "twitter.com", "x.com", "linkedin.com",
  "youtube.com", "netflix.com", "spotify.com", "airbnb.com",
  // Developer / SaaS
  "stripe.com", "notion.so", "slack.com", "shopify.com", "salesforce.com",
  "adobe.com", "hubspot.com", "intercom.com", "atlassian.com", "zoom.us",
  "dropbox.com", "github.com", "gitlab.com", "figma.com", "canva.com",
  "mailchimp.com", "twilio.com", "sendgrid.com", "cloudflare.com",
  "vercel.com", "netlify.com", "supabase.com", "linear.app",
  "asana.com", "monday.com", "clickup.com", "trello.com",
  "okta.com", "auth0.com", "datadog.com", "pagerduty.com",
  "snowflake.com", "databricks.com", "mongodb.com", "elastic.co",
  "hashicorp.com", "docker.com", "kubernetes.io",
  "openai.com", "anthropic.com", "cohere.com", "mistral.ai",
  "zendesk.com", "freshdesk.com", "mixpanel.com", "amplitude.com",
  "segment.com", "braze.com", "klaviyo.com", "typeform.com",
  "airtable.com", "webflow.com", "wix.com", "wordpress.com",
  "squarespace.com", "hubspot.com", "marketo.com",
  "twitch.tv", "uber.com", "lyft.com", "doordash.com",
  "paypal.com", "square.com", "plaid.com", "adyen.com",
  "sentry.io", "newrelic.com", "splunk.com", "grafana.com",
  "confluent.io", "redis.com", "planetscale.com", "neon.tech",
  "loom.com", "miro.com", "notion.so", "craft.do", "bear.app",
  "grammarly.com", "semrush.com", "ahrefs.com", "moz.com",
  "zendesk.com", "intercom.com", "drift.com", "calendly.com",
  "zapier.com", "make.com", "n8n.io",
]);

/** Known AI builder hosting domains */
const KNOWN_AI_BUILDER_DOMAINS = new Set([
  "lovable.app", "lovable.dev", "base44.app", "base44.com",
  "bolt.new", "v0.dev", "replit.app", "replit.co",
  "stackblitz.io", "codesandbox.io", "claude.site",
  "cursor.sh", "glitch.me", "fly.dev",
]);

/** Substrings in the hostname that strongly suggest AI-built/demo */
const AI_BUILDER_HOST_PATTERNS = [
  "lovable", "base44", "bolt-new", "v0-dev", "-bolt",
  "-demo", "-prototype", "-preview", "demo-app",
];

/** Keywords in title/h1 strongly suggesting a demo or AI-built product */
const AI_COPY_SIGNALS = [
  "built with lovable", "built with base44", "made with bolt",
  "ai app", "prototype", "demo app", "demo site", "test app",
  "powered by ai", "app created with",
];

// ── Root domain extraction ────────────────────────────────────────────────────

function extractRootDomain(hostname: string): string {
  const parts = hostname.replace(/^www\./, "").split(".");
  if (parts.length >= 2) return parts.slice(-2).join(".");
  return hostname;
}

// ── Confidence helpers ────────────────────────────────────────────────────────

function clamp(n: number, min = 0, max = 1): number {
  return Math.min(max, Math.max(min, n));
}

// ── Main classifier ───────────────────────────────────────────────────────────

export function classifySiteContext(inputs: SiteContextInputs): SiteContext {
  const {
    hostname, urlPath, title, description, h1Tags, h2Tags,
    wordCount, buttonCount, formCount, hasPricing, hasSignup, hasContact,
    detectedBuilder,
  } = inputs;

  const reasons: string[] = [];
  const signals: Record<string, boolean> = {};
  const hostLower = hostname.toLowerCase();
  const pathLower = urlPath.toLowerCase();
  const titleLower = title.toLowerCase();
  const rootDomain = extractRootDomain(hostLower);
  const allText = [title, description, ...h1Tags, ...h2Tags].join(" ").toLowerCase();

  // ── Signal: known AI builder domain ────────────────────────────────────────
  signals.isKnownBuilderDomain = KNOWN_AI_BUILDER_DOMAINS.has(hostLower) ||
    KNOWN_AI_BUILDER_DOMAINS.has(rootDomain);

  if (!signals.isKnownBuilderDomain) {
    signals.isKnownBuilderDomain = AI_BUILDER_HOST_PATTERNS.some((p) =>
      hostLower.includes(p)
    );
  }

  // ── Signal: builder detected in URL or copy ────────────────────────────────
  signals.hasBuilderCopySignal = AI_COPY_SIGNALS.some((s) =>
    allText.includes(s)
  );

  // ── Signal: known official company domain ─────────────────────────────────
  signals.isKnownOfficialDomain = KNOWN_OFFICIAL_DOMAINS.has(rootDomain);

  // ── Signal: documentation URL ─────────────────────────────────────────────
  signals.isDocumentationPath =
    /\/docs?\b|\/api\b|\/reference\b|\/guide|\/developer|\/handbook|\/learn\b/.test(pathLower) ||
    /^docs\.|^developer\.|^api\./.test(hostLower);

  // ── Signal: internal tool / dashboard ─────────────────────────────────────
  signals.isInternalToolPath =
    /\/dashboard|\/admin|\/console|\/portal|\/workspace|\/settings|\/app\b/.test(pathLower) ||
    /^app\.|^dashboard\.|^admin\.|^console\.|^portal\./.test(hostLower) ||
    (pathLower.startsWith("/app/") && wordCount < 200);

  // ── Signal: e-commerce ────────────────────────────────────────────────────
  signals.isEcommerce =
    /shop|store|buy|cart|checkout|woocommerce|shopify/.test(hostLower) ||
    /\/shop\b|\/store\b|\/products?\b|\/checkout/.test(pathLower);

  // ── Signal: portfolio ─────────────────────────────────────────────────────
  const portfolioKeywords = ["portfolio", "resume", "cv ", "my work", "case study",
    "case studies", "about me", "hire me", "projects"];
  signals.isPortfolio =
    portfolioKeywords.some((k) => allText.includes(k)) ||
    /portfolio|resume|cv\.|\.me\/|\.io\/portfolio/.test(hostLower);

  // ── Signal: startup SaaS ──────────────────────────────────────────────────
  signals.hasSaaSSignals = hasPricing || hasSignup;
  signals.hasLowWordCount = wordCount < 200;
  signals.hasHighWordCount = wordCount > 1000;
  signals.hasForms = formCount > 0;

  // ── Signal: vercel.app with demo-like hostname ────────────────────────────
  const isVercelApp = hostLower.endsWith(".vercel.app");
  if (isVercelApp && (signals.hasLowWordCount || detectedBuilder)) {
    signals.isKnownBuilderDomain = true;
  }

  // ── CLASSIFY ──────────────────────────────────────────────────────────────

  // Priority 1: Known AI builder domain (strongest signal)
  if (signals.isKnownBuilderDomain || detectedBuilder) {
    const confidence = signals.isKnownBuilderDomain ? 0.92 : 0.80;
    if (signals.isKnownBuilderDomain) {
      reasons.push(`Hosted on a known AI builder platform`);
    }
    if (detectedBuilder) {
      reasons.push(`Builder detected: ${detectedBuilder}`);
    }
    if (signals.hasBuilderCopySignal) {
      reasons.push("Page copy references an AI builder tool");
    }
    if (wordCount < 150) {
      reasons.push("Low word count — typical of demo or prototype pages");
    }
    return {
      siteType: "ai_built_site",
      confidence: clamp(confidence + (signals.hasBuilderCopySignal ? 0.05 : 0)),
      reasons: reasons.slice(0, 3),
      detectedBuilder,
      auditNote: "AI-built or prototype site detected. The audit is stricter on product clarity, trust signals, CTA quality, and launch-readiness gaps.",
      _signals: signals,
    };
  }

  // Priority 2: Known official company domain
  if (signals.isKnownOfficialDomain) {
    reasons.push(`Recognised major company domain: ${rootDomain}`);
    if (title.length < 30) {
      reasons.push("Short brand-only title is expected for a mature brand");
    }
    reasons.push("Audit expectations adjusted for a mature, established product");
    // Could still be a docs or tool sub-path
    if (signals.isDocumentationPath) {
      return {
        siteType: "documentation_site",
        confidence: 0.88,
        reasons: [`Documentation path on ${rootDomain}`, "Official company site — marketing checks skipped"],
        detectedBuilder: null,
        auditNote: `Documentation site from ${rootDomain}. Conversion and marketing checks are skipped. Audit focuses on information architecture, navigation, and developer experience.`,
        _signals: signals,
      };
    }
    return {
      siteType: "official_company_site",
      confidence: 0.95,
      reasons: reasons.slice(0, 3),
      detectedBuilder: null,
      auditNote: `Official company site detected (${rootDomain}). Audit adjusts expectations for a mature brand — short brand names and non-conversion-first layouts are treated as intentional product decisions.`,
      _signals: signals,
    };
  }

  // Priority 3: Documentation site by URL
  if (signals.isDocumentationPath) {
    reasons.push("Documentation or developer path detected in URL");
    if (signals.hasHighWordCount) reasons.push("High word count — typical of reference documentation");
    return {
      siteType: "documentation_site",
      confidence: 0.82,
      reasons: reasons.slice(0, 3),
      detectedBuilder: null,
      auditNote: "Documentation or developer site detected. Conversion CTAs, pricing, and sign-up paths are not expected here. Audit focuses on content clarity, navigation, and information architecture.",
      _signals: signals,
    };
  }

  // Priority 4: Internal tool / dashboard
  if (signals.isInternalToolPath) {
    reasons.push("Dashboard or tool path detected in URL");
    if (!hasPricing && !hasSignup) reasons.push("No marketing conversion signals — typical of internal tools");
    return {
      siteType: "internal_tool_or_dashboard",
      confidence: 0.78,
      reasons: reasons.slice(0, 3),
      detectedBuilder: null,
      auditNote: "Internal tool or dashboard detected. Marketing content checks are skipped. Audit focuses on workflow clarity, error states, empty states, navigation, and accessibility.",
      _signals: signals,
    };
  }

  // Priority 5: E-commerce
  if (signals.isEcommerce) {
    reasons.push("E-commerce indicators detected in URL or hostname");
    return {
      siteType: "ecommerce_or_marketplace",
      confidence: 0.80,
      reasons: reasons.slice(0, 3),
      detectedBuilder: null,
      auditNote: "E-commerce or marketplace site detected. Audit prioritises checkout flow, trust signals, mobile experience, and conversion path.",
      _signals: signals,
    };
  }

  // Priority 6: Portfolio
  if (signals.isPortfolio) {
    reasons.push("Portfolio or personal site signals detected");
    reasons.push("Content references work, case studies, or personal positioning");
    return {
      siteType: "portfolio_site",
      confidence: 0.75,
      reasons: reasons.slice(0, 3),
      detectedBuilder: null,
      auditNote: "Portfolio or personal site detected. Audit focuses on positioning clarity, proof points, contact path, and case study quality. Pricing and signup checks are skipped.",
      _signals: signals,
    };
  }

  // Priority 7: Startup landing page
  if (signals.hasSaaSSignals && !signals.isInternalToolPath) {
    const confidence = 0.65 +
      (hasPricing ? 0.05 : 0) +
      (hasSignup ? 0.05 : 0) +
      (hasContact ? 0.03 : 0);
    reasons.push("SaaS product or startup signals detected");
    if (hasPricing) reasons.push("Pricing information found");
    if (hasSignup) reasons.push("Sign-up or account creation path detected");
    return {
      siteType: "startup_landing_page",
      confidence: clamp(confidence),
      reasons: reasons.slice(0, 3),
      detectedBuilder: null,
      auditNote: "Startup or SaaS landing page detected. Audit prioritises value proposition clarity, conversion path, trust signals, and CTA quality.",
      _signals: signals,
    };
  }

  // Fallback: unknown
  reasons.push("Site type could not be determined with high confidence");
  return {
    siteType: "unknown",
    confidence: 0.45,
    reasons: reasons.slice(0, 3),
    detectedBuilder: null,
    auditNote: "Site type could not be determined. A general product audit has been applied.",
    _signals: signals,
  };
}

// ── Context display helpers ───────────────────────────────────────────────────

export const SITE_TYPE_LABELS: Record<SiteContextType, string> = {
  official_company_site: "Official company site",
  ai_built_site: "AI-built / prototype",
  startup_landing_page: "Startup or SaaS landing page",
  portfolio_site: "Portfolio / personal site",
  internal_tool_or_dashboard: "Internal tool or dashboard",
  ecommerce_or_marketplace: "E-commerce or marketplace",
  documentation_site: "Documentation or developer site",
  unknown: "Unknown site type",
};

export const SITE_TYPE_ICONS: Record<SiteContextType, string> = {
  official_company_site: "🏢",
  ai_built_site: "⚡",
  startup_landing_page: "🚀",
  portfolio_site: "🎨",
  internal_tool_or_dashboard: "⚙️",
  ecommerce_or_marketplace: "🛒",
  documentation_site: "📚",
  unknown: "🔍",
};

export function confidenceLabel(c: number): string {
  if (c >= 0.85) return "High";
  if (c >= 0.65) return "Medium";
  return "Low";
}
