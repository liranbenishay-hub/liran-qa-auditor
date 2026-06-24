/**
 * /api/screenshot — Self-hosted screenshot capture endpoint
 *
 * Accepts: POST { "url": "https://example.com" }
 * Returns: { screenshotBase64, capturedAt, viewport, durationMs }
 *
 * Uses @sparticuz/chromium-min + puppeteer-core.
 * The Chromium binary (~80MB) is downloaded from GitHub Releases on cold start
 * and cached in /tmp for warm starts. Package size is ~46KB, well within
 * Vercel Hobby's 50MB compressed function limit.
 *
 * maxDuration = 60 — required for cold start on Vercel.
 * Vercel Hobby supports up to 60s as of late 2024.
 * If you're on an older Hobby plan (10s limit), screenshots will timeout on cold
 * starts but the audit will still succeed (the UI handles this gracefully).
 */

import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60; // Needed for browser cold start + page render

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * Chromium pack hosted on GitHub Releases for @sparticuz/chromium v149.
 * chromium-min downloads this on first invocation and caches it in /tmp.
 * Subsequent (warm) calls reuse the cached binary.
 */
// Starting at v135, Sparticuz uses architecture-specific pack filenames (pack.x64.tar / pack.arm64.tar).
// The old "pack.tar" path returns HTTP 404 for v149+.
const CHROMIUM_PACK_URL =
  "https://github.com/Sparticuz/chromium/releases/download/v149.0.0/chromium-v149.0.0-pack.x64.tar";

const SCREENSHOT_TIMEOUT_MS = 25_000; // 25s — leaves buffer within 60s maxDuration
const PAGE_LOAD_TIMEOUT_MS  = 15_000; // 15s for page load

const VIEWPORT = {
  width: 1280,
  height: 800,
  deviceScaleFactor: 1,
  hasTouch: false,
  // isLandscape removed — not a valid field in puppeteer-core v24 Viewport type
  isMobile: false,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function isValidUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/** Safely normalize the URL — always https when the host allows it */
function normalizeUrl(raw: string): string {
  const u = new URL(raw);
  if (u.protocol === "http:") u.protocol = "https:";
  return u.toString();
}

// ── Route ─────────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const start = Date.now();

  // ── 1. Parse & validate input ──────────────────────────────────────────────
  let body: { url?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const rawUrl = body.url?.trim();
  if (!rawUrl || !isValidUrl(rawUrl)) {
    return NextResponse.json(
      { error: "Missing or invalid 'url' field. Must be http(s)." },
      { status: 400 }
    );
  }

  const targetUrl = normalizeUrl(rawUrl);

  // ── 2. Launch Chromium ─────────────────────────────────────────────────────
  let browser;
  try {
    // Dynamically import to avoid breaking SSR/Edge builds
    const [chromium, puppeteer] = await Promise.all([
      import("@sparticuz/chromium-min").then((m) => m.default),
      import("puppeteer-core").then((m) => m.default),
    ]);

    chromium.setGraphicsMode = false; // Disable WebGL — not needed for screenshots

    console.log("[screenshot] Resolving Chromium executable from:", CHROMIUM_PACK_URL);
    const executablePath = await chromium.executablePath(CHROMIUM_PACK_URL);
    console.log("[screenshot] Chromium executable path:", executablePath);

    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: VIEWPORT,
      executablePath,
      // Must be "shell" — @sparticuz/chromium ships a headless-shell binary,
      // not a full Chrome binary. headless: true launches the wrong mode.
      headless: "shell",
    });
    console.log("[screenshot] Browser launched successfully");
  } catch (err) {
    console.error("[screenshot] Browser launch failed:", err);
    return NextResponse.json(
      {
        error: "Browser launch failed",
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 500 }
    );
  }

  // ── 3. Navigate & screenshot ───────────────────────────────────────────────
  let screenshotBase64: string;
  try {
    const page = await browser.newPage();

    // Block heavy resources that aren't needed for a visual screenshot
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      const type = request.resourceType();
      if (["media", "font"].includes(type)) {
        request.abort();
      } else {
        request.continue();
      }
    });

    await page.goto(targetUrl, {
      waitUntil: "domcontentloaded",
      timeout: PAGE_LOAD_TIMEOUT_MS,
    });

    // Brief pause for above-fold rendering (hero, header, background images)
    await new Promise((r) => setTimeout(r, 1500));

    // ── Screenshot diagnostics — rendered DOM after JS execution ─────────────
    try {
      const renderedHtml = await page.content();
      const renderedWordCount = renderedHtml
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .split(/\s+/).filter(Boolean).length;

      const renderedH1s = [...renderedHtml.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/gi)]
        .map(m => m[1].replace(/<[^>]+>/g, "").trim())
        .filter(Boolean)
        .slice(0, 3);

      const renderedButtons = (renderedHtml.match(/<button\b/gi) ?? []).length;
      const renderedLinks   = (renderedHtml.match(/<a\s/gi) ?? []).length;

      const pageTitle = await page.title();

      console.log(`
╔══════════════════════════════════════════════════════════════════════════════╗
║  SCREENSHOT DIAGNOSTICS (rendered DOM after JS execution)                    ║
║  ${targetUrl.slice(0, 74).padEnd(74)} ║
╠══════════════════════════════════════════════════════════════════════════════╣
║  Page title:                "${pageTitle.slice(0, 50)}"
║  Rendered HTML length:      ${String(renderedHtml.length).padEnd(10)} chars  (${(renderedHtml.length / 1024).toFixed(1)} KB)
║  Rendered word count:       ${String(renderedWordCount).padEnd(10)} (vs fetch-only scan)
║  Rendered H1 tags:          ${String(renderedH1s.length).padEnd(10)} ${renderedH1s[0] ? `"${renderedH1s[0].slice(0, 40)}"` : "(none)"}
║  Rendered <button> tags:    ${String(renderedButtons).padEnd(10)}
║  Rendered <a> tags:         ${String(renderedLinks).padEnd(10)}
╚══════════════════════════════════════════════════════════════════════════════╝
`);
    } catch (diagErr) {
      console.warn("[screenshot] Diagnostics collection failed (non-fatal):", diagErr);
    }

    const buffer = await page.screenshot({
      type: "jpeg",
      quality: 90,
      clip: { x: 0, y: 0, width: VIEWPORT.width, height: VIEWPORT.height },
    });

    screenshotBase64 = Buffer.from(buffer).toString("base64");
    console.log("[screenshot] Screenshot captured successfully, size:", screenshotBase64.length, "chars");
  } catch (err) {
    console.error("[screenshot] Page capture failed:", err);
    await browser.close().catch(() => {});
    return NextResponse.json(
      {
        error: "Page capture failed",
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 500 }
    );
  } finally {
    await browser.close().catch(() => {});
  }

  const durationMs = Date.now() - start;

  return NextResponse.json({
    screenshotBase64,
    capturedAt: new Date().toISOString(),
    viewport: "desktop",
    resolution: `${VIEWPORT.width}x${VIEWPORT.height}`,
    durationMs,
  });
}
