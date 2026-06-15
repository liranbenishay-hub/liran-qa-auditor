import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI Builder QA Auditor — Product & UX audit for AI-built sites",
  description:
    "Paste your Lovable, Base44, Bolt, Claude or Cursor site URL. Get product, UX, and QA issues instantly — with the exact prompt to fix each one in your builder.",
  openGraph: {
    title: "AI Builder QA Auditor",
    description:
      "Audit your AI-built site. Find product, UX & QA issues. Get builder-specific fix prompts.",
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
