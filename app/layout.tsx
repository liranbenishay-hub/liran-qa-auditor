import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI Website Iteration Coach — Feedback & fix prompts for AI-built sites",
  description:
    "Get actionable feedback, visual evidence, and builder-ready prompts for websites built with Lovable, Claude, Base44, Bolt, v0, or Replit. No signup required.",
  openGraph: {
    title: "AI Website Iteration Coach",
    description:
      "Paste your AI-built site URL. Get feedback, visual evidence, and exact fix prompts for Lovable, Claude, Base44, Bolt, v0, and Replit.",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-white text-zinc-900 antialiased">
        {children}
      </body>
    </html>
  );
}
