import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'X402 Video Demo',
  description: 'X402 Video Processing Demo Site',
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
