try {
  const saved = localStorage.getItem("platform-theme");
  const theme =
    saved === "cupcake" || saved === "dracula"
      ? saved
      : matchMedia("(prefers-color-scheme: dark)").matches
        ? "dracula"
        : "cupcake";
  document.documentElement.dataset.theme = theme;
} catch {
  document.documentElement.dataset.theme = "cupcake";
}
