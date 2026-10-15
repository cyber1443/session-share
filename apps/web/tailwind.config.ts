import type { Config } from 'tailwindcss'

export default {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      colors: {
        ink: '#111410',
        panel: '#191d17',
        edge: '#343b2e',
        mute: '#a1aa98',
        accent: '#d2fa69',
      },
    },
  },
  plugins: [],
} satisfies Config
