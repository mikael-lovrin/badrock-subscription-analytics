/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Single brand accent (Badrock red) laid over a neutral admin-style
        // palette — see the dataviz guidance in the project notes for why
        // we keep the accent to one color rather than a rainbow per series.
        brand: {
          DEFAULT: "#CE202F",
          dark: "#a51824",
        },
      },
      fontFamily: {
        sans: [
          "Inter",
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "sans-serif",
        ],
      },
    },
  },
  plugins: [],
};
