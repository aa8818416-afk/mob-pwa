import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "TactileAI - بصيرة وسمع لمسي",
  description: "مساعد الذكاء الاصطناعي اللمسي للمكفوفين والصم - تحويل الأسئلة والخيارات لاهتزازات ذكية",
  manifest: "/manifest.json",
  icons: {
    icon: "/icon.svg",
    apple: "/icon.svg",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
  themeColor: "#090D16",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ar" dir="rtl">
      <head>
        <link rel="manifest" href="/manifest.json" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <meta name="theme-color" content="#090D16" />
      </head>
      <body className="bg-[#090D16] text-white min-h-screen antialiased flex flex-col">
        {children}
      </body>
    </html>
  );
}
