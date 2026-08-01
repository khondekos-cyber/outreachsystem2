import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import Sidebar from "@/components/layout/Sidebar";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "AI Sales CRM",
  description: "Automated WhatsApp Outreach",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={inter.className}>
        <div className="flex">
          <Sidebar />
          <main className="flex-1 ml-0 sm:ml-64 min-h-screen bg-[#f8fafc] pb-16 sm:pb-0">
            {children}
          </main>
        </div>
      </body>
    </html>
  );
}