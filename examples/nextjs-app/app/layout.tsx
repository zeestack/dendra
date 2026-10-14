import { NavBar } from "./NavBar";

export const metadata = {
  title: "dendra × Next.js example",
  description: "Typed RPC/REST, streaming, real-time, and AI tools on Next.js",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // The demo is designed light (dark text on white cards). Pin a light theme so
  // it stays readable when the OS is in dark mode — otherwise the browser's dark
  // canvas shows through as a black background behind the light-mode styles.
  //
  // Flex column: the nav sits on top, and the content area fills the rest — so
  // the full-height Assistant page gets (viewport − nav) instead of overflowing.
  return (
    <html lang="en" style={{ colorScheme: "light" }}>
      <body
        style={{
          background: "#fff",
          color: "#111",
          margin: 0,
          minHeight: "100dvh",
          display: "flex",
          flexDirection: "column",
          fontFamily:
            "system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
        }}
      >
        <NavBar />
        <div
          style={{
            flex: "1 1 auto",
            minHeight: 0,
            display: "flex",
            flexDirection: "column",
          }}
        >
          {children}
        </div>
      </body>
    </html>
  );
}
