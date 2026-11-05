import type { Metadata } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans, IBM_Plex_Sans_Condensed } from "next/font/google";
import "./globals.css";

const plexSans = IBM_Plex_Sans({ variable: "--font-plex-sans", subsets: ["latin", "latin-ext"], weight: "variable" });
const plexCond = IBM_Plex_Sans_Condensed({ variable: "--font-plex-cond", subsets: ["latin", "latin-ext"], weight: "600" });
const plexMono = IBM_Plex_Mono({ variable: "--font-plex-mono", subsets: ["latin", "latin-ext"], weight: ["400", "500"] });

export const metadata: Metadata = {
  title: "InsiderOps – insiderkøb og AI-råd",
  description: "Scanner og multi-agent råd til analyse af insiderkøb. Ingen dokumenteret edge.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="da"
      className={`${plexSans.variable} ${plexCond.variable} ${plexMono.variable} h-full antialiased`}
    >
      <body className="min-h-full bg-paper text-ink font-sans">{children}</body>
    </html>
  );
}
