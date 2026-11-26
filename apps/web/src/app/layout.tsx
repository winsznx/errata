import type { Metadata, Viewport } from "next";
import { IBM_Plex_Sans, Newsreader } from "next/font/google";
import "./globals.css";

const newsreader = Newsreader({ subsets: ["latin"], variable: "--font-newsreader", display: "swap", weight: ["400", "500", "600"], style: ["normal", "italic"] });
const plex = IBM_Plex_Sans({ subsets: ["latin"], variable: "--font-plex", display: "swap", weight: ["400", "500", "600"] });

export const metadata: Metadata = {
  title: { default: "Errata: financial research correction desk", template: "%s · Errata" },
  description: "When financial facts change, fix every report that depended on them. Errata finds research built on restated filings, warns readers, and prepares verified corrections for an editor to reissue.",
  applicationName: "Errata",
};

export const viewport: Viewport = { themeColor: "#f6f7f5", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${newsreader.variable} ${plex.variable}`}>
      <body>
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        {children}
      </body>
    </html>
  );
}
