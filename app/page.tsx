import AuditTool from "@/components/audit-tool";

// Builder logos/names shown in the hero
const BUILDERS = [
  { name: "Lovable",     color: "bg-violet-100 text-violet-700 border-violet-200" },
  { name: "Base44",      color: "bg-blue-100   text-blue-700   border-blue-200"   },
  { name: "Bolt",        color: "bg-amber-100  text-amber-700  border-amber-200"  },
  { name: "Claude",      color: "bg-orange-100 text-orange-700 border-orange-200" },
  { name: "Cursor",      color: "bg-zinc-100   text-zinc-700   border-zinc-200"   },
  { name: "v0",          color: "bg-zinc-900   text-zinc-100   border-zinc-700"   },
  { name: "Replit",      color: "bg-red-100    text-red-700    border-red-200"    },
];

export default function HomePage() {
  return (
    <div className="min-h-screen bg-white">
      {/* ── Top nav ──────────────────────────────────────────────────────── */}
      <header className="border-b border-zinc-100 bg-white/90 backdrop-blur-sm sticky top-0 z-10">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-5 py-3">
          <div className="flex items-center gap-2.5">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-zinc-900 text-white">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
              </svg>
            </span>
            <span className="font-semibold text-zinc-900 text-sm">AI Builder QA</span>
          </div>
          <span className="hidden sm:inline-block rounded-full border border-zinc-200 bg-zinc-50 px-3 py-1 font-mono text-[10px] font-semibold uppercase tracking-widest text-zinc-500">
            Free · No signup
          </span>
        </div>
      </header>

      {/* ── Hero ─────────────────────────────────────────────────────────── */}
      <section className="mx-auto max-w-5xl px-5 pb-8 pt-14 text-center">
        {/* Eyebrow */}
        <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-zinc-200 bg-zinc-50 px-3.5 py-1.5">
          <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
          <span className="font-mono text-[11px] font-semibold uppercase tracking-widest text-zinc-500">
            QA Auditor for AI builders
          </span>
        </div>

        {/* Headline */}
        <h1 className="mx-auto mb-5 max-w-3xl text-4xl font-semibold leading-tight tracking-tight text-zinc-900 sm:text-5xl">
          Paste your AI-built site.<br />
          <span className="text-zinc-400">Find what to fix next.</span>
        </h1>

        {/* Sub-headline */}
        <p className="mx-auto mb-8 max-w-xl text-base leading-relaxed text-zinc-500">
          After every iteration, run a real product, UX and QA audit on your live URL.
          Get prioritised findings — and the exact prompt to fix each issue in your builder.
        </p>

        {/* Builder chips */}
        <div className="mb-10 flex flex-wrap items-center justify-center gap-2">
          {BUILDERS.map((b) => (
            <span
              key={b.name}
              className={`inline-flex items-center rounded-full border px-2.5 py-1 font-mono text-[11px] font-semibold ${b.color}`}
            >
              {b.name}
            </span>
          ))}
          <span className="font-mono text-[11px] text-zinc-400">+ any AI tool</span>
        </div>

        {/* How it works — 3-step */}
        <div className="mx-auto mb-12 grid max-w-2xl grid-cols-3 gap-4 text-center">
          {[
            { step: "1", label: "Paste URL", desc: "Your live AI-built site" },
            { step: "2", label: "Get audit", desc: "Product, UX & QA issues" },
            { step: "3", label: "Fix with prompt", desc: "Builder-specific fix prompt" },
          ].map(({ step, label, desc }) => (
            <div key={step} className="rounded-xl border border-zinc-100 bg-zinc-50 px-4 py-4">
              <div className="mx-auto mb-2 flex h-7 w-7 items-center justify-center rounded-full bg-zinc-900 font-mono text-[11px] font-bold text-white">
                {step}
              </div>
              <p className="text-sm font-semibold text-zinc-800">{label}</p>
              <p className="mt-0.5 font-mono text-[10px] text-zinc-400">{desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── Audit tool ───────────────────────────────────────────────────── */}
      <main className="mx-auto max-w-5xl px-5 pb-20">
        <AuditTool />
      </main>

      {/* ── Footer ───────────────────────────────────────────────────────── */}
      <footer className="border-t border-zinc-100 py-8 text-center">
        <p className="font-mono text-[11px] text-zinc-400">
          AI Builder QA Auditor · Free product audit tool · No AI APIs used · No data stored
        </p>
      </footer>
    </div>
  );
}
