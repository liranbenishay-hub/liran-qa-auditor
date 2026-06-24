/**
 * /api/audit — Real HTML signal extraction endpoint
 *
 * Accepts: POST { "url": "https://example.com" }
 * Returns: Structured audit data parsed from the target page's HTML.
 *
 * No paid APIs, no external AI services.
 * Uses only standard fetch + regex-based HTML parsing.
 * Compatible with Vercel Hobby (10s limit).
 */

import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 55; // Extended: rendered DOM extraction for CSR/SPA sites

// ── Constants ────────────────────────────────────────────────────────────────

const FETCH_TIMEOUT_MS = 8000; // Leave margin for processing
const MAX_CONTENT_BYTES = 2_000_000; // 2MB — enough for any reasonable page
const RENDER_WAIT_MS = 2500; // Wait for React/Vite to hydrate after domcontentloaded
const RENDER_NAV_TIMEOUT_MS = 15_000; // 15s navigation timeout for Puppeteer path

/**
 * Chromium pack for @sparticuz/chromium-min — same binary as /api/screenshot.
 * Cached in /tmp after first download; warm invocations are fast.
 */
const CHROMIUM_PACK_URL =
  "https://github.com/Sparticuz/chromium/releases/download/v149.0.0/chromium-v149.0.0-pack.x64.tar";

const BOT_USER_AGENT =
  "Mozilla/5.0 (compatible; AIBuilderQABot/1.0; +https://aibuilderqa.com/about)";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AuditData {
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
  links: {
    total: number;
    internal: number;
    external: number;
    samples: string[];
  };
  buttons: {
    total: number;
    samples: string[];
  };
  forms: {
    total: number;
    inputs: number;
  };
  images: {
    total: number;
    missingAlt: number;
    withAlt: number;
    missingAltSamples: string[];
  };
  ctaElements: string[];
  signals: {
    hasPricing: boolean;
    pricingIndicators: string[];
    hasSignup: boolean;
    signupIndicators: string[];
    hasContact: boolean;
    contactIndicators: string[];
    hasNewsletter: boolean;
    hasSearch: boolean;
    hasChatWidget: boolean;
    hasCookieBanner: boolean;
    hasMobileViewport: boolean;
    hasCanonical: boolean;
    hasOgTags: boolean;
    hasSchemaMarkup: boolean;
  };
  scripts: number;
  stylesheets: number;
  /**
   * How the page data was obtained:
   * - "static-html"        — server-side HTML from a plain fetch (SSR / static sites)
   * - "rendered-dom"       — browser-rendered DOM captured via Puppeteer (CSR / SPA sites)
   * - "heuristic-fallback" — insufficient data; findings are heuristic-only
   */
  analysisSource: "static-html" | "rendered-dom" | "heuristic-fallback";
}

export interface AuditError {
  error: string;
  url?: string;
  statusCode?: number;
}

// ── HTML utilities ─────────────────────────────────────────────────────────

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)));
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function cleanText(raw: string): string {
  return decodeEntities(stripTags(raw)).replace(/\s+/g, " ").trim();
}

/** Removes <script> and <style> blocks before text extraction */
function removeScriptsAndStyles(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ");
}

/**
 * Extracts text content between all occurrences of an HTML tag.
 * Works for simple non-deeply-nested content (h1, h2, title, etc.)
 */
function extractTagTexts(html: string, tag: string, limit = 20): string[] {
  const results: string[] = [];
  // Use a simple approach: find open tag → find close tag at same depth
  const openRe = new RegExp(`<${tag}(?:\\s[^>]*)?>`, "gi");
  const closeRe = new RegExp(`</${tag}>`, "gi");

  let openMatch: RegExpExecArray | null;
  openRe.lastIndex = 0;

  while (results.length < limit && (openMatch = openRe.exec(html)) !== null) {
    const contentStart = openMatch.index + openMatch[0].length;
    closeRe.lastIndex = contentStart;
    const closeMatch = closeRe.exec(html);
    if (!closeMatch) break;

    const inner = html.slice(contentStart, closeMatch.index);
    const text = cleanText(inner);
    if (text.length > 0 && text.length < 500) {
      results.push(text);
    }
    openRe.lastIndex = closeMatch.index + closeMatch[0].length;
  }
  return results;
}

/** Extracts a meta tag's content attribute given its name */
function extractMeta(html: string, name: string): string {
  const patterns = [
    new RegExp(`<meta\\s[^>]*name=["']${name}["'][^>]*content=["']([^"']*)["']`, "i"),
    new RegExp(`<meta\\s[^>]*content=["']([^"']*)["'][^>]*name=["']${name}["']`, "i"),
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m?.[1]) return decodeEntities(m[1].trim());
  }
  return "";
}

// ── Extraction functions ───────────────────────────────────────────────────

function extractTitle(html: string): string {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? cleanText(m[1]) : "";
}

function extractLinks(
  html: string,
  baseUrl: URL
): { total: number; internal: number; external: number; samples: string[] } {
  const result = { total: 0, internal: 0, external: 0, samples: [] as string[] };
  const re = /<a\s[^>]*href=["']([^"'\s][^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;

  while ((m = re.exec(html)) !== null) {
    const href = m[1].trim();
    if (!href || href.startsWith("javascript:") || href.startsWith("#")) continue;

    result.total++;

    let isExternal = false;
    try {
      const resolved = new URL(href, baseUrl.href);
      isExternal =
        resolved.hostname !== baseUrl.hostname && href.startsWith("http");
    } catch {
      // relative URL — internal
    }

    if (isExternal) {
      result.external++;
    } else {
      result.internal++;
    }

    const text = cleanText(m[2]);
    if (text && text.length <= 100 && result.samples.length < 12) {
      result.samples.push(text);
    }
  }
  return result;
}

function extractButtons(
  html: string
): { total: number; samples: string[] } {
  const samples: string[] = [];

  // <button> elements
  const btnRe = /<button[^>]*>([\s\S]*?)<\/button>/gi;
  let m: RegExpExecArray | null;
  while ((m = btnRe.exec(html)) !== null) {
    const text = cleanText(m[1]);
    if (text && text.length <= 80) samples.push(text);
  }

  // <input type="submit|button">
  const inputRe = /<input\s[^>]*type=["'](submit|button)["'][^>]*/gi;
  while ((m = inputRe.exec(html)) !== null) {
    const valRe = /\bvalue=["']([^"']*)["']/i.exec(m[0]);
    const text = valRe?.[1]?.trim();
    if (text && text.length <= 80) samples.push(text);
  }

  return { total: samples.length, samples: samples.slice(0, 15) };
}

function extractForms(html: string): { total: number; inputs: number } {
  return {
    total: (html.match(/<form\b/gi) ?? []).length,
    inputs: (html.match(/<input\b/gi) ?? []).length,
  };
}

function extractImages(html: string): {
  total: number;
  missingAlt: number;
  withAlt: number;
  missingAltSamples: string[];
} {
  const result = {
    total: 0,
    missingAlt: 0,
    withAlt: 0,
    missingAltSamples: [] as string[],
  };
  const imgRe = /<img(\s[^>]*)?(?:\/?>|>)/gi;
  let m: RegExpExecArray | null;

  while ((m = imgRe.exec(html)) !== null) {
    result.total++;
    const attrs = m[1] ?? "";
    const altM = /\balt=["']([^"']*)["']/i.exec(attrs);

    if (!altM || altM[1].trim() === "") {
      result.missingAlt++;
      if (result.missingAltSamples.length < 5) {
        const srcM = /\bsrc=["']([^"']*)["']/i.exec(attrs);
        if (srcM) result.missingAltSamples.push(srcM[1].slice(0, 100));
      }
    } else {
      result.withAlt++;
    }
  }
  return result;
}

function extractCTAs(buttonSamples: string[], linkSamples: string[]): string[] {
  const CTA_TERMS = [
    "get started", "start free", "try free", "free trial", "sign up",
    "create account", "join free", "join now", "start now", "get access",
    "book demo", "request demo", "watch demo", "see demo", "schedule demo",
    "book a call", "talk to us", "download", "install", "contact us",
    "learn more", "buy now", "purchase", "upgrade", "subscribe",
    "get quote", "start building", "explore", "try it", "start trial",
  ];

  const found = new Set<string>();
  for (const text of [...buttonSamples, ...linkSamples]) {
    const lower = text.toLowerCase();
    for (const term of CTA_TERMS) {
      if (lower.includes(term)) {
        found.add(text.slice(0, 80));
        break;
      }
    }
    if (found.size >= 10) break;
  }
  return Array.from(found);
}

function detectSignals(
  html: string,
  plainText: string
): AuditData["signals"] {
  const lower = plainText.toLowerCase();
  const htmlLower = html.toLowerCase();

  // Pricing
  const PRICING_PATTERNS: RegExp[] = [
    /\$\s?\d+/, /€\s?\d+/, /£\s?\d+/,
    /per month/i, /per year/i, /\/mo\b/i, /\/yr\b/i,
    /pricing/i, /\bplans?\b/i, /\bpackages?\b/i, /\btiers?\b/i,
  ];
  const pricingIndicators: string[] = [];
  for (const p of PRICING_PATTERNS) {
    const m = p.exec(lower) ?? p.exec(htmlLower);
    if (m && !pricingIndicators.includes(m[0])) {
      pricingIndicators.push(m[0]);
    }
  }

  // Signup
  const SIGNUP_TERMS = [
    "sign up", "signup", "register", "create account", "create an account",
    "join free", "get started for free", "start for free",
  ];
  const signupIndicators = SIGNUP_TERMS.filter(
    (t) => lower.includes(t) || htmlLower.includes(t)
  );

  // Contact
  const CONTACT_TERMS = ["contact", "support", "help center", "mailto:", "tel:"];
  const contactIndicators = CONTACT_TERMS.filter(
    (t) => lower.includes(t) || htmlLower.includes(t)
  );

  return {
    hasPricing: pricingIndicators.length > 0,
    pricingIndicators: [...new Set(pricingIndicators)].slice(0, 6),
    hasSignup: signupIndicators.length > 0,
    signupIndicators: signupIndicators.slice(0, 5),
    hasContact: contactIndicators.length > 0,
    contactIndicators: contactIndicators.slice(0, 5),
    hasNewsletter:
      lower.includes("newsletter") ||
      lower.includes("subscribe to") ||
      htmlLower.includes('type="email"'),
    hasSearch:
      htmlLower.includes('type="search"') ||
      htmlLower.includes('role="search"') ||
      lower.includes("search"),
    hasChatWidget:
      htmlLower.includes("intercom") ||
      htmlLower.includes("zendesk") ||
      htmlLower.includes("crisp") ||
      htmlLower.includes("drift") ||
      htmlLower.includes("hubspot"),
    hasCookieBanner:
      lower.includes("cookie") ||
      lower.includes("gdpr") ||
      htmlLower.includes("cookieconsent"),
    hasMobileViewport: htmlLower.includes("viewport"),
    hasCanonical: htmlLower.includes('rel="canonical"'),
    hasOgTags:
      htmlLower.includes("og:title") ||
      htmlLower.includes("og:description"),
    hasSchemaMarkup:
      htmlLower.includes('"@type"') ||
      htmlLower.includes("application/ld+json"),
  };
}

// ── SPA / hydration detection ─────────────────────────────────────────────────

interface HydrationInfo {
  hydrationDetected: boolean;
  markers: string[];
}

interface CSRInfo {
  isCSR: boolean;
  /** Subjective confidence based on number and strength of CSR signals */
  confidence: "high" | "medium" | "low" | "none";
  reasons: string[];
}

function detectHydration(html: string): HydrationInfo {
  const markers: string[] = [];
  if (html.includes("data-reactroot"))            markers.push("data-reactroot");
  if (html.includes("__NEXT_DATA__"))             markers.push("__NEXT_DATA__");
  if (html.includes("_reactRootContainer"))       markers.push("_reactRootContainer");
  if (html.includes("__NUXT__"))                  markers.push("__NUXT__");
  if (html.includes("__vue_app__"))               markers.push("__vue_app__");
  if (html.includes("ng-version"))                markers.push("ng-version (Angular)");
  if (html.includes("__REACT_QUERY_STATE__"))     markers.push("__REACT_QUERY_STATE__");
  if (html.includes("vite/client"))               markers.push("vite/client");
  if (html.includes("__vite_is_modern_browser"))  markers.push("vite-modern-detect");
  if (html.includes("@vite/client"))              markers.push("@vite/client");
  if (html.includes("__REDUX_DEVTOOLS_EXTENSION__")) markers.push("Redux DevTools");
  return { hydrationDetected: markers.length > 0, markers };
}

function detectCSR(
  html: string,
  wordCount: number,
  h1Count: number,
  buttonCount: number,
  scriptCount: number,
): CSRInfo {
  const reasons: string[] = [];

  // Empty root div — strongest CSR signal
  const emptyRootDiv = /<div[^>]*\bid=["']root["'][^>]*>\s*<\/div>/i.test(html);
  const emptyAppDiv  = /<div[^>]*\bid=["']app["'][^>]*>\s*<\/div>/i.test(html);
  if (emptyRootDiv)  reasons.push("empty #root div");
  if (emptyAppDiv)   reasons.push("empty #app div");

  // High script count + thin content
  if (scriptCount > 4 && wordCount < 80)  reasons.push(`${scriptCount} scripts, only ${wordCount} words`);
  if (scriptCount > 8)                    reasons.push(`very high script count (${scriptCount})`);

  // No semantic content at all
  if (h1Count === 0 && buttonCount === 0 && wordCount < 30) {
    reasons.push("no H1, no buttons, <30 words — shell HTML only");
  }

  // Vite / CRA / webpack bundle filenames
  if (/assets\/index[-.\w]+\.js/.test(html))        reasons.push("Vite bundle (assets/index-*.js)");
  if (/\/static\/js\/main\.\w+\.js/.test(html))     reasons.push("CRA bundle (/static/js/main.*.js)");
  if (/chunk[-\w]+\.js/.test(html))                 reasons.push("webpack chunk detected");

  // Lovable / builder-specific signals
  if (html.includes("lovable-tagger"))              reasons.push("lovable-tagger script");
  if (html.includes("lovableproject.com"))          reasons.push("lovableproject.com reference");
  if (html.includes("gptengineer"))                 reasons.push("GPT Engineer / Lovable origin");

  const signalCount = reasons.length;
  const hasDefinitiveSignal = emptyRootDiv || emptyAppDiv;
  const isCSR = hasDefinitiveSignal || signalCount >= 2;
  const confidence: CSRInfo["confidence"] =
    hasDefinitiveSignal && signalCount >= 3 ? "high" :
    hasDefinitiveSignal || signalCount >= 3 ? "medium" :
    signalCount >= 2 ? "low" : "none";

  return { isCSR, confidence, reasons };
}

// ── Rendered DOM extraction (for CSR / SPA pages) ────────────────────────────

/**
 * Launches a headless Chromium browser, navigates to the URL, waits for the
 * JavaScript framework to hydrate, and returns the fully-rendered HTML.
 *
 * Used when static fetch detects a CSR shell (empty #root div, Vite bundles,
 * near-zero text). Falls back gracefully — returns null on any failure so the
 * caller can stick with static signals.
 *
 * Shares the same Chromium binary as /api/screenshot (cached in /tmp).
 */
async function extractRenderedDOM(
  url: string,
): Promise<{ html: string; pageTitle: string } | null> {
  let browser: import("puppeteer-core").Browser | undefined;
  try {
    const [chromium, puppeteer] = await Promise.all([
      import("@sparticuz/chromium-min").then((m) => m.default),
      import("puppeteer-core").then((m) => m.default),
    ]);

    chromium.setGraphicsMode = false;
    console.log("[audit/render] Resolving Chromium binary...");
    const executablePath = await chromium.executablePath(CHROMIUM_PACK_URL);

    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: { width: 1280, height: 800, deviceScaleFactor: 1, hasTouch: false, isMobile: false },
      executablePath,
      headless: "shell" as NonNullable<Parameters<typeof puppeteer.launch>[0]>["headless"],
    });
    console.log("[audit/render] Browser launched");

    const page = await browser.newPage();

    // Block images/media/fonts — we need JS + CSS to render, not assets
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      if (["image", "media", "font"].includes(req.resourceType())) {
        req.abort().catch(() => {});
      } else {
        req.continue().catch(() => {});
      }
    });

    console.log(`[audit/render] Navigating to ${url}...`);
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: RENDER_NAV_TIMEOUT_MS,
    });

    // Wait for React / Vite to hydrate and render components above the fold
    console.log(`[audit/render] Waiting ${RENDER_WAIT_MS}ms for JS hydration...`);
    await new Promise((r) => setTimeout(r, RENDER_WAIT_MS));

    const html      = await page.content();
    const pageTitle = await page.title();

    console.log(
      `[audit/render] ✓ Rendered HTML: ${html.length} chars | title: "${pageTitle}"`,
    );
    return { html, pageTitle };
  } catch (err) {
    console.error(
      "[audit/render] ✗ Rendered DOM extraction failed:",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

// ── Route handler ─────────────────────────────────────────────────────────────

export async function POST(
  request: NextRequest
): Promise<NextResponse<AuditData | AuditError>> {
  // ── Parse request body
  let body: { url?: unknown } | null = null;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!body?.url || typeof body.url !== "string") {
    return NextResponse.json(
      { error: "Missing required field: url (string)" },
      { status: 400 }
    );
  }

  // ── Validate and normalise URL
  let targetUrl: URL;
  try {
    const raw = body.url.trim();
    const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    targetUrl = new URL(withProtocol);
  } catch {
    return NextResponse.json({ error: "Invalid URL format" }, { status: 400 });
  }

  if (!["http:", "https:"].includes(targetUrl.protocol)) {
    return NextResponse.json(
      { error: "Only HTTP and HTTPS URLs are supported" },
      { status: 400 }
    );
  }

  // ── Fetch the page
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const fetchStart = Date.now();

  let html: string;
  let statusCode: number;

  try {
    const response = await fetch(targetUrl.href, {
      signal: controller.signal,
      headers: {
        "User-Agent": BOT_USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Cache-Control": "no-cache",
      },
      redirect: "follow",
    });

    statusCode = response.status;

    const contentType = response.headers.get("content-type") ?? "";
    const isHtml =
      contentType.includes("text/html") ||
      contentType.includes("text/plain") ||
      contentType.includes("application/xhtml");

    if (!isHtml) {
      return NextResponse.json(
        {
          error: `Page returned unsupported content type: ${contentType.split(";")[0]}`,
          url: targetUrl.href,
          statusCode,
        },
        { status: 422 }
      );
    }

    const buffer = await response.arrayBuffer();
    const slice =
      buffer.byteLength > MAX_CONTENT_BYTES
        ? buffer.slice(0, MAX_CONTENT_BYTES)
        : buffer;
    html = new TextDecoder("utf-8", { fatal: false }).decode(slice);
  } catch (err) {
    const isTimeout = (err as Error).name === "AbortError";
    return NextResponse.json(
      {
        error: isTimeout
          ? `Request timed out after ${FETCH_TIMEOUT_MS / 1000}s`
          : `Could not fetch URL: ${(err as Error).message}`,
        url: targetUrl.href,
      },
      { status: isTimeout ? 408 : 502 }
    );
  } finally {
    clearTimeout(timeoutId);
  }

  const fetchDuration = Date.now() - fetchStart;

  // ── Static HTML parse (always runs) ────────────────────────────────────────
  // Use `let` so the rendered DOM path can replace these with richer signals.
  let title       = extractTitle(html);
  let description = extractMeta(html, "description");
  let h1Tags      = extractTagTexts(html, "h1", 10);
  let h2Tags      = extractTagTexts(html, "h2", 20);
  let links       = extractLinks(html, targetUrl);
  let buttons     = extractButtons(html);
  let forms       = extractForms(html);
  let images      = extractImages(html);

  const textHtml = removeScriptsAndStyles(html);
  const plainText = cleanText(textHtml);
  let wordCount = plainText.split(/\s+/).filter(Boolean).length;

  let ctaElements = extractCTAs(buttons.samples, links.samples);
  let signals     = detectSignals(html, plainText);

  const scripts = (html.match(/<script\b/gi) ?? []).length;
  const stylesheets = (
    html.match(/<link\s[^>]*rel=["']stylesheet["']/gi) ?? []
  ).length;

  // ── CSR detection — decide whether to attempt rendered DOM extraction ───────
  const hydration = detectHydration(html);
  const csr       = detectCSR(html, wordCount, h1Tags.length, buttons.total, scripts);

  // ── Rendered DOM extraction (CSR / SPA path) ────────────────────────────────
  let analysisSource: AuditData["analysisSource"] = "static-html";
  let renderedWordCount: number | null = null;
  let renderedH1Count:   number | null = null;
  let renderedBtnCount:  number | null = null;

  if (csr.isCSR) {
    console.log(
      `[audit] CSR detected (${csr.confidence} confidence) — attempting rendered DOM extraction`,
    );
    const rendered = await extractRenderedDOM(targetUrl.href);

    if (rendered) {
      const rTextHtml   = removeScriptsAndStyles(rendered.html);
      const rPlainText  = cleanText(rTextHtml);
      const rWordCount  = rPlainText.split(/\s+/).filter(Boolean).length;
      const rH1Tags     = extractTagTexts(rendered.html, "h1", 10);
      const rButtons    = extractButtons(rendered.html);

      renderedWordCount = rWordCount;
      renderedH1Count   = rH1Tags.length;
      renderedBtnCount  = rButtons.total;

      // Only adopt rendered signals if they are meaningfully richer than static.
      // This guards against accidentally using a Puppeteer error page.
      const isRicher = rWordCount > wordCount + 30 || rWordCount > 60;
      if (isRicher) {
        title       = extractTitle(rendered.html) || rendered.pageTitle || title;
        description = extractMeta(rendered.html, "description") || description;
        h1Tags      = rH1Tags;
        h2Tags      = extractTagTexts(rendered.html, "h2", 20);
        links       = extractLinks(rendered.html, targetUrl);
        buttons     = rButtons;
        forms       = extractForms(rendered.html);
        images      = extractImages(rendered.html);
        wordCount   = rWordCount;
        ctaElements = extractCTAs(rButtons.samples, links.samples);
        signals     = detectSignals(rendered.html, rPlainText);
        analysisSource = "rendered-dom";
        console.log(
          `[audit] ✓ Rendered DOM adopted: ${rWordCount} words, ${rH1Tags.length} H1s, ${rButtons.total} buttons`,
        );
      } else {
        console.log(
          `[audit] Rendered DOM not richer (${rWordCount} rendered vs ${wordCount} static words) — keeping static signals`,
        );
      }
    } else {
      console.log("[audit] Rendered DOM extraction returned null — keeping static signals");
    }
  }

  // ── Diagnostics — printed to server logs for every scan ─────────────────────
  // (hydration and csr already computed above for the CSR branch decision)

  // Extract a representative body snippet (up to 500 chars starting from <body)
  const bodyTagIdx = html.toLowerCase().indexOf("<body");
  const bodySnippet = bodyTagIdx >= 0
    ? html.slice(bodyTagIdx, bodyTagIdx + 600).replace(/\s+/g, " ")
    : html.slice(0, 600).replace(/\s+/g, " ");

  // Inline HTML after script/style removal — shows what the parser actually sees
  const textOnlyLength = textHtml.length;

  const renderedSection = analysisSource === "rendered-dom"
    ? `╠══════════════════════════════════════════════════════════════════════════════╣
║  RENDERED DOM EXTRACTION                                                     ║
║    Analysis source:         rendered-dom (Puppeteer)                         ║
║    Rendered word count:     ${String(renderedWordCount ?? "n/a").padEnd(10)}                                   ║
║    Rendered H1 count:       ${String(renderedH1Count ?? "n/a").padEnd(10)}                                   ║
║    Rendered button count:   ${String(renderedBtnCount ?? "n/a").padEnd(10)}                                   ║
║    ✓ Rendered signals adopted — final values above reflect rendered DOM      ║`
    : csr.isCSR
      ? `╠══════════════════════════════════════════════════════════════════════════════╣
║  RENDERED DOM EXTRACTION                                                     ║
║    Analysis source:         static-html (rendered extraction skipped/failed) ║
║    Rendered word count:     ${String(renderedWordCount ?? "n/a").padEnd(10)}                                   ║
║    Rendered H1 count:       ${String(renderedH1Count ?? "n/a").padEnd(10)}                                   ║
║    ✗ Rendered signals NOT adopted — static signals used for audit            ║`
      : `╠══════════════════════════════════════════════════════════════════════════════╣
║  RENDERED DOM EXTRACTION                                                     ║
║    Analysis source:         static-html (CSR not detected — skip render)     ║`;

  console.log(`
╔══════════════════════════════════════════════════════════════════════════════╗
║  SCAN DIAGNOSTICS                                                            ║
║  ${targetUrl.href.slice(0, 74).padEnd(74)} ║
╠══════════════════════════════════════════════════════════════════════════════╣
║  RAW HTML (static fetch)                                                     ║
║    Full HTML length:        ${String(html.length).padEnd(10)} chars  (${(html.length / 1024).toFixed(1)} KB)                    ║
║    Text-only HTML length:   ${String(textOnlyLength).padEnd(10)} chars  (scripts/styles removed)           ║
║    Plain text length:       ${String(plainText.length).padEnd(10)} chars                                   ║
║    Status code:             ${String(statusCode).padEnd(10)} | Fetch duration: ${fetchDuration}ms                ║
╠══════════════════════════════════════════════════════════════════════════════╣
║  FINAL EXTRACTED SIGNALS (after any rendered DOM adoption)                   ║
║    Visible word count:      ${String(wordCount).padEnd(10)}                                   ║
║    H1 tags found:           ${String(h1Tags.length).padEnd(10)} ${(h1Tags.length > 0 ? `"${h1Tags[0].slice(0, 40)}"` : "(none)").padEnd(44)}║
║    Buttons found:           ${String(buttons.total).padEnd(10)} ${(buttons.samples.slice(0, 2).join(" | ") || "(none)").slice(0, 44).padEnd(44)}║
║    Links found:             ${String(links.total).padEnd(10)} (${links.internal} internal, ${links.external} external)
║    Scripts:                 ${String(scripts).padEnd(10)} | Stylesheets: ${stylesheets}
║    Title:                   "${title.slice(0, 60)}"
║    Description:             "${description.slice(0, 60)}"
╠══════════════════════════════════════════════════════════════════════════════╣
║  SPA / HYDRATION ANALYSIS                                                    ║
║    Hydration detected:      ${(hydration.hydrationDetected ? "YES" : "NO").padEnd(10)}                                   ║
║    Hydration markers:       ${(hydration.markers.join(", ") || "(none)").slice(0, 50)}
║    Client-side rendered:    ${(csr.isCSR ? `YES (${csr.confidence} confidence)` : "NO (or SSR)").padEnd(30)}
║    CSR reasons:             ${(csr.reasons[0] ?? "(none)").slice(0, 50)}
${csr.reasons.slice(1).map(r => `║                             ${r.slice(0, 50)}`).join("\n")}
${renderedSection}
╠══════════════════════════════════════════════════════════════════════════════╣
║  STATIC BODY SNIPPET (first 500 chars of <body>)                             ║
${bodySnippet.slice(0, 500).match(/.{1,76}/g)?.map(l => `║  ${l.padEnd(76)}║`).join("\n") ?? ""}
╚══════════════════════════════════════════════════════════════════════════════╝
`);

  // ── Respond
  const result: AuditData = {
    url: targetUrl.href,
    fetchedAt: new Date().toISOString(),
    fetchDuration,
    pageSize: Buffer.from(html, "utf8").length,
    statusCode,
    title,
    description,
    h1Tags,
    h2Tags,
    wordCount,
    links,
    buttons,
    forms,
    images,
    ctaElements,
    signals,
    scripts,
    stylesheets,
    analysisSource,
  };

  return NextResponse.json(result);
}

// ── Health check ──────────────────────────────────────────────────────────────

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({
    status: "ok",
    endpoint: "POST /api/audit",
    accepts: { url: "string (http/https)" },
    version: "1.0.0",
  });
}

// ── CORS preflight ────────────────────────────────────────────────────────────

export async function OPTIONS(): Promise<NextResponse> {
  return new NextResponse(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}
