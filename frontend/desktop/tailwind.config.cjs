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
        // Neutral fill + status roles, registered as RGB TRIPLETS so their
        // `/NN` alpha modifiers emit CSS.
        //
        // These five families (and the `sidebar-*` set below) were previously
        // declared ONLY as opaque component classes in styles/tokens.css, so
        // every `hover:bg-accent/50`, `text-sidebar-foreground/60` or
        // `border-destructive/30` in the tree emitted nothing at all —
        // measured 201 occurrences across 58 files, which is why the rail had
        // no text hierarchy and destructive affordances had no red edge.
        // A triplet is what makes `<alpha-value>` work; the hex twin in
        // tokens.css stays for the hand-written rules that read it, and
        // src/test/design-tokens.test.ts asserts the two never drift.
        secondary: {
          DEFAULT: 'rgb(var(--dt-secondary-rgb) / <alpha-value>)',
          foreground: 'var(--dt-secondary-foreground)',
        },
        accent: {
          DEFAULT: 'rgb(var(--dt-accent-rgb) / <alpha-value>)',
          foreground: 'var(--dt-accent-foreground)',
        },
        destructive: {
          DEFAULT: 'rgb(var(--dt-destructive-rgb) / <alpha-value>)',
          foreground: 'var(--dt-destructive-foreground)',
        },
        input: 'rgb(var(--dt-input-rgb) / <alpha-value>)',
        ring: 'rgb(var(--dt-ring-rgb) / <alpha-value>)',
        sidebar: {
          DEFAULT: 'rgb(var(--dt-sidebar-rgb) / <alpha-value>)',
          foreground: 'rgb(var(--dt-sidebar-foreground-rgb) / <alpha-value>)',
          primary: 'rgb(var(--dt-sidebar-primary-rgb) / <alpha-value>)',
          'primary-foreground': 'var(--dt-sidebar-primary-foreground)',
          accent: 'rgb(var(--dt-sidebar-accent-rgb) / <alpha-value>)',
          'accent-foreground': 'var(--dt-sidebar-accent-foreground)',
          border: 'rgb(var(--dt-sidebar-border-rgb) / <alpha-value>)',
          ring: 'rgb(var(--dt-sidebar-ring-rgb) / <alpha-value>)',
        },
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
        // src/styles/tokens.css. These keys MUST stay flat:
        //
        // this was `elev: { flat, ring, raised, overlay }`, and Tailwind's
        // boxShadow namespace is not one of the flattened ones (only colors
        // and spacing are), so `shadow-elev-raised` never emitted a rule —
        // measured 0 occurrences of `.shadow-elev` in the built stylesheet
        // against 9 call sites, including the <Surface> primitive, which is
        // why every "elevated" surface in the app fell back to a bare
        // `shadow-md`/`shadow-2xl` or to nothing at all. The ladder is now
        // spelled out key by key so the class names in the tree resolve.
        'elev-flat': 'var(--elev-flat)',
        'elev-ring': 'var(--elev-ring)',
        'elev-raised': 'var(--elev-raised)',
        'elev-overlay': 'var(--elev-overlay)',
        // `soft` and `overlay` read the same ladder from
        // src/styles/tokens.css (audit P2#17) instead of repeating the
        // values, so a Tailwind `shadow-soft` and a
        // `<Surface elev="raised">` are the same shadow by construction.
        overlay: 'var(--elev-overlay)',
        soft: 'var(--elev-raised)',
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
