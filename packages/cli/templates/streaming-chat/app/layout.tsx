export const metadata = {
  title: "{{name}}",
  description: "Streaming commerce chat powered by CodeSpar + Vercel AI SDK",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
