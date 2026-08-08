import { PRODUCT_NAME } from "@/lib/brand";
import { BrandMark } from "./brand-mark";
import { ThemeToggle } from "./theme-toggle";

export function AuthShell({ children }: { children: React.ReactNode }) {
  return (
    <main className="auth-surface relative grid min-h-screen place-items-center overflow-hidden p-4 sm:p-6">
      <div className="absolute right-4 top-4 z-10 sm:right-6 sm:top-6">
        <ThemeToggle compact />
      </div>
      <section className="card relative z-10 w-full max-w-lg overflow-hidden border border-base-300/80 bg-base-100/95 shadow-2xl backdrop-blur">
        <div className="flex items-center gap-3 border-b border-base-300 px-6 py-5 sm:px-8">
          <BrandMark className="size-10 shrink-0 drop-shadow-sm" />
          <div>
            <div className="text-lg font-bold tracking-tight">{PRODUCT_NAME}</div>
            <div className="text-xs text-base-content/60">Private flake deployment host</div>
          </div>
        </div>
        {children}
      </section>
    </main>
  );
}
