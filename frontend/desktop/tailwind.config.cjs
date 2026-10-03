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
        // Contrast tiers. Registered here as well as defined in styles.css so
        // that variant forms work: a plain `.text-tier-N` CSS rule cannot be
        // prefixed, so `hover:text-tier-1`, `placeholder:text-tier-3` and
        // `aria-selected:text-tier-1` were silently emitting no CSS at all.
        // Hex (not `-hsl` channel) vars, so `/NN` alpha modifiers are not
        // supported on these.
        tier: {
          1: 'var(--dt-fg-1)',
          2: 'var(--dt-fg-2)',
          3: 'var(--dt-fg-3)',
        },
        // Role tokens that carry their own per-theme value (plain hex/rgb
        // vars, no alpha slot — same restriction as `tier`).
        sunken: 'var(--dt-surface-sunken)',
        paper: 'var(--dt-paper)',
        scrim: 'var(--dt-overlay-scrim)',
        wash: 'var(--dt-wash)',
        'hairline-strong': 'var(--dt-hairline-strong)',
        // Status colors: RGB triplets, so every alpha modifier works
        // natively (bg-success/15, border-danger/30, text-warning-fg, …).
        // The -fg variants are the contrast-tuned TEXT colors per theme
        // (plain vars — no alpha needed). These replace the raw Tailwind
        // green/red/amber/emerald palette classes (2026-10-03 audit §2).
        success: 'rgb(var(--dt-success-rgb) / <alpha-value>)',
        warning: 'rgb(var(--dt-warning-rgb) / <alpha-value>)',
        danger: 'rgb(var(--dt-danger-rgb) / <alpha-value>)',
        info: 'rgb(var(--dt-info-rgb) / <alpha-value>)',
        'success-fg': 'var(--dt-success-fg)',
        'warning-fg': 'var(--dt-warning-fg)',
        'danger-fg': 'var(--dt-danger-fg)',
        'info-fg': 'var(--dt-info-fg)',
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
      // Rem-based type scale below the tailwind defaults. Plain strings (no
      // lineHeight pair) so swapping `text-[10px]` for `text-3xs` keeps the
      // inherited line-height untouched — the codemod that retired the px
      // literals relied on that. Being rem-based, these scale with the
      // `data-text-size` root font-size (styles.css), which absolute px
      // classes silently ignored (2026-09-26 audit P0#1).
      fontSize: {
        '3xs': '0.625rem',
        '2xs': '0.6875rem',
      },
      boxShadow: {
        // The four-rung elevation ladder (audit P2#17), defined once in
        // src/styles/tokens.css and exposed as `shadow-elev-*` so the
        // <Surface> primitive and a hand-written utility cannot disagree.
        elev: {
          flat:    'var(--elev-flat)',
          ring:    'var(--elev-ring)',
          raised:  'var(--elev-raised)',
          overlay: 'var(--elev-overlay)',
        },
        // `soft` and `overlay` now read the elevation ladder from
        // src/styles/tokens.css (audit P2#17) instead of repeating the
        // values, so a Tailwind `shadow-soft` and a
        // `<Surface elev="raised">` are the same shadow by construction.
        overlay: 'var(--elev-overlay)',
        soft:    'var(--elev-raised)',
        // `ring` is the FOCUS ring (4px brand-tinted halo), not a surface
        // elevation — it is a different vocabulary from --elev-ring, which
        // is the 1px border-coloured edge.
        ring:    '0 0 0 4px rgb(74 138 255 / 0.18)',
        // `xs` is the hairline step used by the composer attachment chips;
        // it predates the four-rung ladder and stays on the Tailwind side
        // rather than becoming a fifth rung for two call sites.
        xs:      '0 1px 2px rgb(0 0 0 / 0.04)',
      },
    },
  },
  plugins: [require('tailwindcss-animate')],
};
