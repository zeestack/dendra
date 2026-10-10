export const metadata = {
  title: "dendra × Next.js example",
  description: "Typed RPC/REST, streaming, real-time, and AI tools on Next.js",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
