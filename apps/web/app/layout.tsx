import "./globals.css";
export const metadata = {
  title: "SpecTwin — API simulation workspace",
  description: "Stateful API sandboxes for reproducible integration tests.",
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
