import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'session-share',
  description: 'Split one issue across several devs and their Claude Codes.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">{children}</body>
    </html>
  )
}
