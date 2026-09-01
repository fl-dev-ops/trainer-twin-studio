import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Geist, Geist_Mono } from "next/font/google";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/sonner";
import { resolveSessionUser } from "@/lib/session-user";
import { TenantBasePathProvider } from "@/lib/tenant-context";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "TrainerTwin Studio",
  description: "Build, version, and talk to interview trainer agents",
};

export default async function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  const { org } = await resolveSessionUser();
  const basePath = org?.basePath || "";

  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`} suppressHydrationWarning>
      <head>
        <meta name="twin-base-path" content={basePath} />
      </head>
      <body className="min-h-full bg-background font-sans text-foreground">
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
          <TenantBasePathProvider basePath={basePath}>
            {children}
          </TenantBasePathProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
