import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'NEMWEB Forecast Tracker',
  description: 'Half-hourly NEM demand and rooftop PV POE forecasts versus actuals.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
