import type { Metadata } from "next";
import { BRAND_MARK_PATH, PRODUCT_NAME } from "@/lib/brand";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: PRODUCT_NAME, template: `%s · ${PRODUCT_NAME}` },
  description: "control plane for trusted Nix flake deployments.",
  icons: {
    icon: [{ url: BRAND_MARK_PATH, type: "image/png" }],
    shortcut: BRAND_MARK_PATH,
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script src="/theme-init.js" />
      </head>
      <body className="bg-base-200 text-base-content">{children}</body>
    </html>
  );
}
