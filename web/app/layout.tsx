import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'KernelForge Playground',
  description:
    'Micro-benchmark playground with a memory-hierarchy visualizer and roofline analysis. Simulation mode does not execute submitted code.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
