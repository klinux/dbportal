import localFont from "next/font/local";

/**
 * IBM Plex Sans and Mono, the typefaces docs/DESIGN.md names, self-hosted from the woff2
 * files beside this module (latin subset, the weights the design uses; SIL OFL 1.1, see
 * LICENSE-IBM-Plex.txt) so a build never fetches fonts.googleapis.com and a deployment
 * behind a firewall renders exactly what a developer's machine does. The CSS variable
 * names stay `--font-geist-sans` / `--font-geist-mono`: globals.css and the embedded
 * workspace map them to `--font-sans` / `--font-mono`, and a rename would reach every host
 * that already embeds the studio.
 */
export const sans = localFont({
  src: [
    { path: "./fonts/ibm-plex-sans-latin-400-normal.woff2", weight: "400", style: "normal" },
    { path: "./fonts/ibm-plex-sans-latin-500-normal.woff2", weight: "500", style: "normal" },
    { path: "./fonts/ibm-plex-sans-latin-600-normal.woff2", weight: "600", style: "normal" },
    { path: "./fonts/ibm-plex-sans-latin-700-normal.woff2", weight: "700", style: "normal" },
  ],
  variable: "--font-geist-sans",
  display: "swap",
  fallback: ["ui-sans-serif", "system-ui", "-apple-system", "Segoe UI", "Roboto", "Helvetica Neue", "Arial", "sans-serif"],
});

export const mono = localFont({
  src: [
    { path: "./fonts/ibm-plex-mono-latin-400-normal.woff2", weight: "400", style: "normal" },
    { path: "./fonts/ibm-plex-mono-latin-500-normal.woff2", weight: "500", style: "normal" },
    { path: "./fonts/ibm-plex-mono-latin-600-normal.woff2", weight: "600", style: "normal" },
  ],
  variable: "--font-geist-mono",
  display: "swap",
  fallback: ["ui-monospace", "SFMono-Regular", "Menlo", "Consolas", "monospace"],
});
