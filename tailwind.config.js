/** @type {import('tailwindcss').Config} */
// The same token values live as --pombo-* in components.css (:root) and as
// PomboColors on Android; change all three together.
module.exports = {
  content: [
    "./*.html",
    "./src/js/**/*.js"
  ],
  theme: {
    extend: {
      fontFamily: {
        'inter': ['Inter', 'sans-serif'],
      },
      colors: {
        'primary': '#E4E4E7',
        'accent': {
          DEFAULT: '#F6851B',
          hover: '#E5780F',
          dim: '#AC5D13',
        },
        'danger': '#EF4444',
        'success': '#22C55E',
        'warning': '#FBBF24',
        'info': '#60A5FA',
        'surface': {
          DEFAULT: '#111113',
          raised: '#16161B',
          1: '#09090B',
          2: '#0A0A0A',
          3: '#0B0B0E',
          4: '#0E0E10',
          5: '#0F0F12',
          8: '#18181B',
          9: '#1A1A1A',
          10: '#1E1E1E',
        },
        // White at N % opacity
        'overlay': {
          1: 'rgb(255 255 255 / 0.01)',
          2: 'rgb(255 255 255 / 0.02)',
          3: 'rgb(255 255 255 / 0.03)',
          4: 'rgb(255 255 255 / 0.04)',
          5: 'rgb(255 255 255 / 0.05)',
          6: 'rgb(255 255 255 / 0.06)',
          8: 'rgb(255 255 255 / 0.08)',
          10: 'rgb(255 255 255 / 0.1)',
          12: 'rgb(255 255 255 / 0.12)',
          14: 'rgb(255 255 255 / 0.14)',
          15: 'rgb(255 255 255 / 0.15)',
          20: 'rgb(255 255 255 / 0.2)',
          25: 'rgb(255 255 255 / 0.25)',
          30: 'rgb(255 255 255 / 0.3)',
          35: 'rgb(255 255 255 / 0.35)',
          40: 'rgb(255 255 255 / 0.4)',
          45: 'rgb(255 255 255 / 0.45)',
          50: 'rgb(255 255 255 / 0.5)',
          55: 'rgb(255 255 255 / 0.55)',
          60: 'rgb(255 255 255 / 0.6)',
          70: 'rgb(255 255 255 / 0.7)',
          75: 'rgb(255 255 255 / 0.75)',
          80: 'rgb(255 255 255 / 0.8)',
          85: 'rgb(255 255 255 / 0.85)',
          87: 'rgb(255 255 255 / 0.87)',
          90: 'rgb(255 255 255 / 0.9)',
        },
        'bubble': {
          own: '#272A2E',
          'own-text': '#F0F0F0',
          other: '#1E1E1E',
          'other-text': '#D1D5DB',
        },
      },
    },
  },
  plugins: [],
}
