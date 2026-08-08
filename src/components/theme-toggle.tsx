"use client";

export function ThemeToggle({ compact = false }: { compact?: boolean }) {
  function toggleTheme() {
    const root = document.documentElement;
    const next = root.dataset.theme === "dracula" ? "cupcake" : "dracula";
    root.dataset.theme = next;
    localStorage.setItem("platform-theme", next);
  }

  return (
    <button
      type="button"
      className={
        compact
          ? "btn btn-circle btn-ghost border border-base-300 bg-base-100/80"
          : "btn btn-ghost btn-sm w-full justify-start gap-3"
      }
      onClick={toggleTheme}
      aria-label="Toggle color theme"
      title="Toggle color theme"
    >
      <span className="theme-show-light" aria-hidden="true">
        <MoonIcon />
      </span>
      <span className="theme-show-dark" aria-hidden="true">
        <SunIcon />
      </span>
      {!compact && (
        <>
          <span className="theme-show-light">Use dark theme</span>
          <span className="theme-show-dark">Use light theme</span>
        </>
      )}
    </button>
  );
}

function MoonIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="size-5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      aria-hidden="true"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M20.25 15.15A8.25 8.25 0 0 1 8.85 3.75a8.25 8.25 0 1 0 11.4 11.4Z"
      />
    </svg>
  );
}

function SunIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="size-5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="3.5" />
      <path
        strokeLinecap="round"
        d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.65 17.65l1.42 1.42M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.65 6.35l1.42-1.42"
      />
    </svg>
  );
}
