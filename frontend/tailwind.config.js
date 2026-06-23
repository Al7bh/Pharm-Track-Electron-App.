/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        background: "#031427",
        "surface-container": "#102034",
        "surface-container-low": "#0b1c30",
        "surface-container-high": "#1b2b3f",
        "surface-container-highest": "#26364a",
        "surface-variant": "#26364a",
        "surface-bright": "#2a3a4f",
        secondary: "#4edea3",
        "secondary-fixed-dim": "#4edea3",
        "secondary-container": "#00a572",
        "on-secondary-fixed": "#002113",
        "on-surface": "#d3e4fe",
        "on-surface-variant": "#c6c6cd",
        "outline-variant": "#45464d",
        "error-container": "#93000a",
        "on-error-container": "#ffdad6",
      },
    },
  },
  plugins: [],
}