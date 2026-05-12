import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Codex Remote Console",
  description: "Private web console for server-side Codex sessions"
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
