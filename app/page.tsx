import AuditTool from "@/components/audit-tool";

export default function HomePage() {
  return (
    <div className="min-h-screen bg-white">
      <main className="mx-auto w-full max-w-[1440px] px-4 sm:px-6 lg:px-12">
        <AuditTool />
      </main>
    </div>
  );
}
