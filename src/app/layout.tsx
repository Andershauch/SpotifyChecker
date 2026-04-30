import type { Metadata } from "next";
import { Geist } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "SpotifyCheck",
  description:
    "Daily Spotify playlist availability checks with Neon, Vercel Cron, and Resend alerts.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="da" className={geistSans.variable}>
      <body>{children}</body>
    </html>
  );
}
