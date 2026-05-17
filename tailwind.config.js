/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./src/**/*.ts"],
  theme: {
    extend: {
      colors: {
        "zee-bg":      "#FAF8F4",
        "zee-cream":   "#FAF8F4",
        "zee-text":    "#1A1A1A",
        "zee-primary": "#1A6B62",
        "zee-muted":   "#6B6B6B",
        "zee-gold":    "#C49A1A",
        "zee-border":  "#E8E4DE",
      },
      fontFamily: {
        sans: ['"DM Sans"', "system-ui", "sans-serif"],
      },
    },
  },
};
