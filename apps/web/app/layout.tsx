import "./globals.css";
import { Atkinson_Hyperlegible_Mono, Host_Grotesk } from "next/font/google";

const sans = Host_Grotesk({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-host-grotesk",
});
const mono = Atkinson_Hyperlegible_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-atkinson-mono",
});
export const metadata = {
  title: "SpecTwin — API simulation workspace",
  description: "Stateful API sandboxes for reproducible integration tests.",
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
