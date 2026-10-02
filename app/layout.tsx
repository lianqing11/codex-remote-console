import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import "./appearance.css";
import { appearanceBootstrapScript } from "./appearance";
import { MobileViewport } from "./MobileViewport";

const inter = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-sans"
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-mono"
});

const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "";

export const metadata: Metadata = {
  title: "Coding Agent Console",
  description: "Private web console for server-side coding agent sessions",
  manifest: `${basePath}/manifest.webmanifest`,
  appleWebApp: { capable: true, title: "Agent Console", statusBarStyle: "default" }
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
  themeColor: "#ffffff"
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning className={`${inter.variable} ${jetbrainsMono.variable}`}>
      <head><script dangerouslySetInnerHTML={{ __html: appearanceBootstrapScript }} /></head>
      <body><MobileViewport />{children}</body>
    </html>
  );
}
