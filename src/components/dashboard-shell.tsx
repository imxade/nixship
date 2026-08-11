"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { PRODUCT_NAME } from "@/lib/brand";
import { AssistantDrawer } from "./ai/assistant-drawer";
import { BrandMark } from "./brand-mark";
import { ThemeToggle } from "./theme-toggle";

const items = [
  ["/apps", "Applications", "apps"],
  ["/deployments", "Deployments", "deployments"],
  ["/integrations/github", "GitHub", "github"],
  ["/integrations/harbur", "Harbur", "harbur"],
  ["/integrations/cloudflare", "Cloudflare", "cloud"],
  ["/users", "Users", "users"],
  ["/account", "Account", "account"],
  ["/system", "System", "system"],
] as const;

export function DashboardShell({
  children,
  username,
  role,
}: {
  children: React.ReactNode;
  username: string;
  role: string;
}) {
  const pathname = usePathname();
  return (
    <div className="drawer lg:drawer-open min-h-screen">
      <input id="platform-drawer" type="checkbox" className="drawer-toggle" />
      <div className="dashboard-surface drawer-content flex min-h-screen min-w-0 flex-col">
        <header className="navbar sticky top-0 z-20 gap-2 border-b border-base-300 bg-base-100/95 px-3 backdrop-blur lg:hidden">
          <label
            htmlFor="platform-drawer"
            className="btn btn-square btn-ghost"
            aria-label="Open navigation"
          >
            ☰
          </label>
          <Link href="/apps" className="flex min-w-0 flex-1 items-center gap-2.5">
            <BrandMark className="size-8 shrink-0 drop-shadow-sm" />
            <span className="truncate text-xl font-bold tracking-tight">{PRODUCT_NAME}</span>
          </Link>
          <ThemeToggle compact />
        </header>
        <main className="mx-auto w-full min-w-0 max-w-[96rem] flex-1 p-4 sm:p-5 md:p-7 xl:p-9">
          {children}
        </main>
      </div>
      <aside className="drawer-side z-30">
        <label htmlFor="platform-drawer" aria-label="Close navigation" className="drawer-overlay" />
        <div className="flex min-h-full w-72 flex-col border-r border-base-300 bg-base-100/95 p-4 shadow-2xl backdrop-blur lg:shadow-none">
          <Link href="/apps" className="flex items-center gap-3 px-3 py-4">
            <BrandMark className="size-10 shrink-0 drop-shadow-sm" />
            <div>
              <div className="text-xl font-bold">{PRODUCT_NAME}</div>
              <div className="text-xs text-base-content/60">Deployment control plane</div>
            </div>
          </Link>
          <ul className="menu mt-4 gap-1 p-0">
            {items
              .filter(([href]) => href !== "/users" || role === "owner" || role === "admin")
              .map(([href, label, icon]) => (
                <li key={href}>
                  <Link
                    href={href}
                    className={
                      pathname === href ||
                      (href !== "/apps" && pathname.startsWith(href)) ||
                      (href === "/apps" && pathname.startsWith("/apps"))
                        ? "active"
                        : ""
                    }
                  >
                    <NavIcon name={icon} />
                    {label}
                  </Link>
                </li>
              ))}
          </ul>
          <div className="mt-auto space-y-2 border-t border-base-300 pt-4">
            <ThemeToggle />
            <div className="rounded-lg bg-base-200/70 px-3 py-2.5">
              <div className="font-medium">{username}</div>
              <div className="text-xs uppercase tracking-wide text-base-content/60">{role}</div>
            </div>
            <form action="/api/auth/logout" method="post">
              <input type="hidden" name="intent" value="logout" />
              <button type="submit" className="btn btn-ghost btn-sm w-full justify-start">
                Sign out
              </button>
            </form>
          </div>
        </div>
      </aside>
      <AssistantDrawer />
    </div>
  );
}

type NavIconName = (typeof items)[number][2];

function NavIcon({ name }: { name: NavIconName }) {
  const paths: Record<NavIconName, React.ReactNode> = {
    apps: (
      <>
        <rect x="3" y="3" width="7" height="7" rx="1.5" />
        <rect x="14" y="3" width="7" height="7" rx="1.5" />
        <rect x="3" y="14" width="7" height="7" rx="1.5" />
        <rect x="14" y="14" width="7" height="7" rx="1.5" />
      </>
    ),
    deployments: (
      <>
        <path d="M20 7h-5V2" />
        <path d="M4 17h5v5" />
        <path d="M18.4 18A8 8 0 0 1 5.1 16.9" />
        <path d="M5.6 6A8 8 0 0 1 18.9 7.1" />
      </>
    ),
    github: (
      <path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3.3-.4 6.8-1.6 6.8-7.4A5.8 5.8 0 0 0 19.3 3 5.4 5.4 0 0 0 19.1-.9S17.9-1.3 15 1a13.4 13.4 0 0 0-6 0C6.1-1.3 4.9-.9 4.9-.9A5.4 5.4 0 0 0 4.7 3a5.8 5.8 0 0 0-1.5 4.1c0 5.8 3.5 7 6.8 7.4A4.8 4.8 0 0 0 9 18v4" />
    ),
    harbur: (
      <>
        <path d="M4 18h16M6 18l2-8h8l2 8M9 10V6h6v4" />
        <path d="M3 21c2-1 4-1 6 0s4 1 6 0 4-1 6 0" />
      </>
    ),
    cloud: <path d="M17.5 19H6a4 4 0 0 1-.5-8A6.5 6.5 0 0 1 18 9a5 5 0 0 1-.5 10Z" />,
    users: (
      <>
        <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
        <circle cx="9" cy="7" r="4" />
        <path d="M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8" />
      </>
    ),
    account: (
      <>
        <circle cx="12" cy="8" r="4" />
        <path d="M4 21a8 8 0 0 1 16 0" />
      </>
    ),
    system: (
      <>
        <rect x="3" y="3" width="18" height="18" rx="3" />
        <path d="M8 12h8M12 8v8" />
      </>
    ),
  };
  return (
    <svg
      viewBox="0 0 24 24"
      className="size-5 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}
