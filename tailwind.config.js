/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/renderer/index.html', './src/renderer/src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#f1f4ff',
          100: '#dfe5ff',
          200: '#c7d2ff',
          300: '#a3b4ff',
          400: '#7689ff',
          500: '#4b5dff',
          600: '#2f3fed',
          700: '#2431c0',
          800: '#1e2a94',
          900: '#1c2875'
        }
      }
    }
  },
  plugins: []
};

