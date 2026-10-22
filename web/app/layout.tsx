import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Figtree, Geist_Mono } from "next/font/google";
import { ThemeProvider } from "@/components/theme-provider";
import { PostHogTracker } from "@/components/posthog/tracker";
import { Suspense } from "react";
import { Toaster } from "@/components/ui/sonner";
import "./globals.css";

const figtree = Figtree({
  variable: "--font-figtree",
  subsets: ["latin"],
  weight: "variable",
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "TrainerTwin Studio",
  description: "Build, version, and talk to interview trainer agents",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" className={`${figtree.variable} ${geistMono.variable} h-full antialiased`} suppressHydrationWarning>
      <body className="min-h-full bg-background font-sans text-foreground">
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
          {children}
        </ThemeProvider>
        <Toaster />
        <Suspense>
          <PostHogTracker />
        </Suspense>
      </body>
    </html>
  );
}
