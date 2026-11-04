import "./globals.css";
// Self-hosted faces, so a build never depends on reaching Google Fonts.
import "@fontsource/host-grotesk/400.css";
import "@fontsource/host-grotesk/500.css";
import "@fontsource/atkinson-hyperlegible-mono/400.css";
import "@fontsource/atkinson-hyperlegible-mono/500.css";
export const metadata = {
  title: "SpecTwin — API simulation workspace",
  description: "Stateful API sandboxes for reproducible integration tests.",
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `try{var m=localStorage.getItem("spectwin-mode");if(m==="light"||m==="dark")document.documentElement.dataset.mode=m}catch(e){}`,
          }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
