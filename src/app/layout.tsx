import { withBasePath } from "@/lib/config/base-path";
import { mono, sans } from "@/app/fonts";
import type { Metadata } from "next";
import "./globals.css";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/sonner";

const title = "dbportal | Shared database portal";
const description =
  "Self-hosted database portal for SRE, DevOps and developers: one set of shared datasources, single sign-on, and an audit trail of every single execution.";
// Link previews point at the public repository asset, including on private deployments.
const siteUrl = "https://github.com/klinux/dbportal";
const previewImage = {
  url: `https://raw.githubusercontent.com/klinux/dbportal/main/public/brand/og-image.png`,
  alt: "dbportal — one deployment, one set of datasources, every execution attributed to a person",
};

export const metadata: Metadata = {
  title,
  description,
  openGraph: {
    type: "website",
    url: siteUrl,
    title,
    description,
    siteName: "dbportal",
    images: [{ ...previewImage, width: 1200, height: 630 }],
  },
  twitter: {
    card: "summary_large_image",
    title,
    description,
    images: [previewImage],
  },
  manifest: withBasePath("/site.webmanifest"),
  icons: {
    icon: [
      { url: withBasePath("/favicon.ico?v=2"), sizes: "any" },
      { url: withBasePath("/logo.svg?v=2"), type: "image/svg+xml" },
    ],
    shortcut: withBasePath("/favicon.ico?v=2"),
    apple: [{ url: withBasePath("/apple-touch-icon.png"), sizes: "180x180", type: "image/png" }],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    // suppressHydrationWarning is scoped to <html>/<body> only: browser extensions
    // (Grammarly, dark-mode injectors, ...) mutate attributes on these two elements
    // before React hydrates. It suppresses attribute/text mismatches on THESE nodes
    // alone — real hydration bugs inside {children} are still reported.
    <html lang="en" suppressHydrationWarning>
      {/*
        The `dark` class used to be written here, which pinned standalone studio to
        one theme. It is now owned by ThemeProvider, which writes it onto <html>
        (`attribute="class"`) and restores the user's choice before paint.
      */}
      <body suppressHydrationWarning className={`${sans.variable} ${mono.variable} antialiased font-sans`}>
        <ThemeProvider>
          {children}
          {/* No `theme` prop: Toaster reads next-themes itself, so it follows. */}
          <Toaster position="bottom-right" />
        </ThemeProvider>
      </body>
    </html>
  );
}
