export async function register(): Promise<void> {
  if (process.env.DISABLE_PLATFORM_RUNTIME === "1") return;
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { bootRuntime } = await import("./src/server/runtime.ts");
    await bootRuntime();
  }
}
