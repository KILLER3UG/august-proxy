module.exports = {
  darkMode: 'class',
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx}'
  ],
  theme: {
    extend: {
      colors: {
        // Design tokens backed by `--dt-*-hsl` channels (see src/styles.css).
        // The `<alpha-value>` slot lets Tailwind alpha modifiers work:
        //   bg-card/95, bg-muted/70, border-border/60, text-foreground/90, …
        // Without this registration those `/NN` classes silently failed to
        // apply alpha (the tokens were only plain opaque `.bg-*` CSS classes),
        // which was the root cause of the update overlay appearing transparent.
        background: 'hsl(var(--dt-background-hsl) / <alpha-value>)',
        foreground: 'hsl(var(--dt-foreground-hsl) / <alpha-value>)',
        card: {
          DEFAULT: 'hsl(var(--dt-card-hsl) / <alpha-value>)',
          foreground: 'hsl(var(--dt-card-foreground-hsl) / <alpha-value>)',
        },
        muted: {
          DEFAULT: 'hsl(var(--dt-muted-hsl) / <alpha-value>)',
          foreground: 'hsl(var(--dt-muted-foreground-hsl) / <alpha-value>)',
        },
        popover: {
          DEFAULT: 'hsl(var(--dt-popover-hsl) / <alpha-value>)',
          foreground: 'hsl(var(--dt-popover-foreground-hsl) / <alpha-value>)',
        },
        primary: {
          DEFAULT: 'hsl(var(--dt-primary-hsl) / <alpha-value>)',
          foreground: 'hsl(var(--dt-primary-foreground-hsl) / <alpha-value>)',
        },
        border: 'hsl(var(--dt-border-hsl) / <alpha-value>)',
      },
      fontFamily: {
        sans: [
          'Inter Variable',
          'Inter',
          '-apple-system',
          'BlinkMacSystemFont',
          'Segoe UI',
          'system-ui',
          'sans-serif',
        ],
        mono: [
          'JetBrains Mono Variable',
          'ui-monospace',
          'Cascadia Code',
          'Source Code Pro',
          'Menlo',
          'Consolas',
          'monospace',
        ],
      },
      letterSpacing: {
        tightest: '-0.04em',
        display:  '-0.022em',
        body:     '-0.011em',
        caps:     '0.08em',
      },
      borderRadius: {
        xs: '4px',
        sm: '6px',
        md: '8px',
        lg: '12px',
        xl: '16px',
        '2xl': '20px',
      },
      boxShadow: {
        overlay: '0 24px 48px -12px rgb(0 0 0 / 0.45)',
        soft:    '0 1px 2px rgb(0 0 0 / 0.06), 0 1px 3px rgb(0 0 0 / 0.10)',
        ring:    '0 0 0 4px rgb(74 138 255 / 0.18)',
        xs:      '0 1px 2px rgb(0 0 0 / 0.04)',
      },
    },
  },
  plugins: [require('tailwindcss-animate')],
};
