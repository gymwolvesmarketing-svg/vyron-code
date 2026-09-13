import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Vyron Code",
  description: "Project-aware AI coding workspace (v0.1 — read-only)",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
