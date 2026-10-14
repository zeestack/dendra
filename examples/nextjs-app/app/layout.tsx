import "./globals.css";
import { NavBar } from "./NavBar";

export const metadata = {
  title: "dendra × Next.js example",
  description: "Typed RPC/REST, streaming, real-time, and AI tools on Next.js",
};

// Apply the saved theme before first paint so there's no flash of the wrong one.
const noFlashTheme = `try{var t=localStorage.getItem('theme');if(t==='light'||t==='dark')document.documentElement.setAttribute('data-theme',t)}catch(e){}`;

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Flex column (via globals.css body): the nav sits on top, and the content
  // area fills the rest — so the full-height Assistant gets (viewport − nav).
  // suppressHydrationWarning: the no-flash script sets data-theme before React.
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: noFlashTheme }} />
      </head>
      <body>
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
