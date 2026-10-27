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
