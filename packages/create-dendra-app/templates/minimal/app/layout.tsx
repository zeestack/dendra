import type { ReactNode } from "react";

export const metadata = {
  title: "{{projectName}}",
  description: "A Next.js app built on dendra",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          fontFamily: "system-ui, sans-serif",
          maxWidth: 640,
          margin: "40px auto",
          padding: "0 16px",
          lineHeight: 1.6,
        }}
      >
        {children}
      </body>
    </html>
  );
}
