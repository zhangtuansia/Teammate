import type { Metadata } from "next";
import { Geist_Mono } from "next/font/google";
import { snProFont } from "@/fonts/font";
import "./globals.css";
import { cn } from "@/lib/utils";

const geistMono = Geist_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Zano",
  description: "Human-AI collaboration platform",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={cn(
        "h-full antialiased",
        snProFont.variable,
        geistMono.variable,
      )}
    >
      <body className="h-full">{children}</body>
    </html>
  );
}
