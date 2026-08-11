import type { Config } from 'tailwindcss'

export default {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      colors: {
        ink: '#07080a',
        panel: '#0e1014',
        edge: '#1c2027',
        mute: '#6b7280',
        accent: '#4ade80',
      },
    },
  },
  plugins: [],
} satisfies Config
