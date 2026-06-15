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
export const maxDuration = 10; // Vercel Hobby plan compatible

// ── Constants ────────────────────────────────────────────────────────────────

const FETCH_TIMEOUT_MS = 8000; // Leave 2s margin for processing
const MAX_CONTENT_BYTES = 2_000_000; // 2MB — enough for any reasonable page

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

  // ── Parse HTML
  const title = extractTitle(html);
  const description = extractMeta(html, "description");
  const h1Tags = extractTagTexts(html, "h1", 10);
  const h2Tags = extractTagTexts(html, "h2", 20);
  const links = extractLinks(html, targetUrl);
  const buttons = extractButtons(html);
  const forms = extractForms(html);
  const images = extractImages(html);

  // Strip scripts/styles before text analysis
  const textHtml = removeScriptsAndStyles(html);
  const plainText = cleanText(textHtml);
  const wordCount = plainText.split(/\s+/).filter(Boolean).length;

  const ctaElements = extractCTAs(buttons.samples, links.samples);
  const signals = detectSignals(html, plainText);

  const scripts = (html.match(/<script\b/gi) ?? []).length;
  const stylesheets = (
    html.match(/<link\s[^>]*rel=["']stylesheet["']/gi) ?? []
  ).length;

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
