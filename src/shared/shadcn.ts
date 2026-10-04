// A design system as a shadcn/ui theme: CSS variables for :root and .dark, the Tailwind v4 mapping,
// components.json, and a few components/ui files that use them.
import { buildDesign, fontStack, type BuiltDesign, type DesignInput, type Roles } from './design'

/**
 * shadcn's variables from the system's roles. shadcn's `accent` is the hover/selected surface (menus,
 * ghost buttons), not a brand colour, so the system's accent goes to `highlight` instead.
 */
export function shadcnVars(r: Roles, d: BuiltDesign, theme: 'light' | 'dark'): Record<string, string> {
  const s = d.scales
  return {
    background: r.background,
    foreground: r.text,
    card: r.surface,
    'card-foreground': r.text,
    popover: r.surfaceRaised,
    'popover-foreground': r.text,
    primary: r.primary,
    'primary-foreground': r.onPrimary,
    secondary: r.surfaceRaised,
    'secondary-foreground': r.text,
    muted: r.surface,
    'muted-foreground': r.textMuted,
    accent: r.surfaceRaised,
    'accent-foreground': r.text,
    destructive: r.danger,
    'destructive-foreground': r.onDanger,
    border: r.border,
    input: r.borderStrong,
    ring: r.focus,
    highlight: r.accent,
    'highlight-foreground': r.onAccent,
    'chart-1': s.brand[theme === 'dark' ? 400 : 600],
    'chart-2': (s.accent ?? s.brand)[theme === 'dark' ? 300 : 500],
    'chart-3': s.success[500],
    'chart-4': s.warning[500],
    'chart-5': s.danger[500],
    sidebar: r.surface,
    'sidebar-foreground': r.text,
    'sidebar-primary': r.primary,
    'sidebar-primary-foreground': r.onPrimary,
    'sidebar-accent': r.surfaceRaised,
    'sidebar-accent-foreground': r.text,
    'sidebar-border': r.border,
    'sidebar-ring': r.focus
  }
}

const block = (selector: string, vars: Record<string, string>, extra: string[] = []) => [`${selector} {`, ...extra.map((l) => `  ${l}`), ...Object.entries(vars).map(([k, v]) => `  --${k}: ${v};`), '}'].join('\n')

/** app/globals.css for a shadcn/ui project on Tailwind v4. */
export function toShadcnCss(input: DesignInput, d = buildDesign(input)): string {
  const light = input.mode !== 'dark'
  const dark = input.mode !== 'light'
  const base = light ? shadcnVars(d.roles.light, d, 'light') : shadcnVars(d.roles.dark, d, 'dark')
  const names = Object.keys(base)
  const fonts = [`--font-sans: ${fontStack(input, 'sans')};`, `--font-heading: ${fontStack(input, 'heading')};`, `--font-mono: ${fontStack(input, 'mono')};`]
  return [
    "@import 'tailwindcss';",
    "@import 'tw-animate-css';",
    '',
    '@custom-variant dark (&:is(.dark *));',
    '',
    block(':root', base, [`--radius: ${d.radii.md}px;`, ...fonts]),
    ...(light && dark ? ['', block('.dark', shadcnVars(d.roles.dark, d, 'dark'))] : []),
    '',
    '@theme inline {',
    ...names.map((n) => `  --color-${n}: var(--${n});`),
    '  --font-sans: var(--font-sans);',
    '  --font-heading: var(--font-heading);',
    '  --font-mono: var(--font-mono);',
    '  --radius-sm: calc(var(--radius) - 4px);',
    '  --radius-md: calc(var(--radius) - 2px);',
    '  --radius-lg: var(--radius);',
    '  --radius-xl: calc(var(--radius) + 4px);',
    '}',
    '',
    '@layer base {',
    '  * {',
    '    @apply border-border outline-ring/50;',
    '  }',
    '  body {',
    '    @apply bg-background text-foreground font-sans;',
    '  }',
    '  h1, h2, h3, h4 {',
    '    font-family: var(--font-heading);',
    '  }',
    '}',
    ''
  ].join('\n')
}

export const SHADCN_COMPONENTS_JSON = `${JSON.stringify(
  {
    $schema: 'https://ui.shadcn.com/schema.json',
    style: 'new-york',
    rsc: false,
    tsx: true,
    tailwind: { config: '', css: 'app/globals.css', baseColor: 'neutral', cssVariables: true, prefix: '' },
    aliases: { components: '@/components', utils: '@/lib/utils', ui: '@/components/ui', lib: '@/lib', hooks: '@/hooks' },
    iconLibrary: 'lucide'
  },
  null,
  2
)}\n`

const UTILS = `import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
`

const BUTTON = `import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50",
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground shadow-xs hover:bg-primary/90',
        destructive: 'bg-destructive text-destructive-foreground shadow-xs hover:bg-destructive/90',
        outline: 'border bg-background shadow-xs hover:bg-accent hover:text-accent-foreground',
        secondary: 'bg-secondary text-secondary-foreground shadow-xs hover:bg-secondary/80',
        ghost: 'hover:bg-accent hover:text-accent-foreground',
        link: 'text-primary underline-offset-4 hover:underline'
      },
      size: {
        default: 'h-9 px-4 py-2',
        sm: 'h-8 rounded-md gap-1.5 px-3',
        lg: 'h-10 rounded-md px-6',
        icon: 'size-9'
      }
    },
    defaultVariants: { variant: 'default', size: 'default' }
  }
)

function Button({ className, variant, size, asChild = false, ...props }: React.ComponentProps<'button'> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : 'button'
  return <Comp data-slot="button" className={cn(buttonVariants({ variant, size, className }))} {...props} />
}

export { Button, buttonVariants }
`

const BADGE = `import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const badgeVariants = cva('inline-flex items-center justify-center rounded-md border px-2 py-0.5 text-xs font-medium w-fit whitespace-nowrap shrink-0 gap-1', {
  variants: {
    variant: {
      default: 'border-transparent bg-primary text-primary-foreground',
      secondary: 'border-transparent bg-secondary text-secondary-foreground',
      destructive: 'border-transparent bg-destructive text-destructive-foreground',
      outline: 'text-foreground',
      // The design system's accent: things worth noticing that aren't actions.
      highlight: 'border-transparent bg-highlight text-highlight-foreground'
    }
  },
  defaultVariants: { variant: 'default' }
})

function Badge({ className, variant, ...props }: React.ComponentProps<'span'> & VariantProps<typeof badgeVariants>) {
  return <span data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />
}

export { Badge, badgeVariants }
`

const CARD = `import * as React from 'react'
import { cn } from '@/lib/utils'

function Card({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="card" className={cn('bg-card text-card-foreground flex flex-col gap-6 rounded-xl border py-6 shadow-sm', className)} {...props} />
}

function CardHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="card-header" className={cn('grid auto-rows-min items-start gap-1.5 px-6', className)} {...props} />
}

function CardTitle({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="card-title" className={cn('leading-none font-semibold', className)} {...props} />
}

function CardDescription({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="card-description" className={cn('text-muted-foreground text-sm', className)} {...props} />
}

function CardContent({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="card-content" className={cn('px-6', className)} {...props} />
}

function CardFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return <div data-slot="card-footer" className={cn('flex items-center px-6', className)} {...props} />
}

export { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter }
`

const INPUT = `import * as React from 'react'
import { cn } from '@/lib/utils'

function Input({ className, type, ...props }: React.ComponentProps<'input'>) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        'placeholder:text-muted-foreground border-input h-9 w-full min-w-0 rounded-md border bg-transparent px-3 py-1 text-base shadow-xs outline-none transition-[color,box-shadow] disabled:cursor-not-allowed disabled:opacity-50 md:text-sm',
        'focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]',
        'aria-invalid:border-destructive aria-invalid:ring-destructive/20',
        className
      )}
      {...props}
    />
  )
}

export { Input }
`

/** The shadcn files, by path relative to a project root. */
export function shadcnFiles(input: DesignInput, d = buildDesign(input)): Record<string, string> {
  return {
    'app/globals.css': toShadcnCss(input, d),
    'components.json': SHADCN_COMPONENTS_JSON,
    'lib/utils.ts': UTILS,
    'components/ui/button.tsx': BUTTON,
    'components/ui/badge.tsx': BADGE,
    'components/ui/card.tsx': CARD,
    'components/ui/input.tsx': INPUT
  }
}

/** DESIGN.md's shadcn section: how the system maps onto shadcn's names. */
export function shadcnMarkdown(): string[] {
  return [
    '## shadcn/ui',
    '',
    'The `shadcn/` folder holds the same system as a shadcn/ui theme: `app/globals.css` (CSS variables for both themes and the Tailwind v4 mapping), `components.json`, and Button, Badge, Card and Input in `components/ui/`. Add more components with `npx shadcn@latest add <name>`: they pick up the theme automatically.',
    '',
    '| shadcn variable | Design role |',
    '|---|---|',
    '| `--background`, `--foreground` | `--color-background`, `--color-text` |',
    '| `--card`, `--popover` | `--color-surface`, `--color-surface-raised` |',
    '| `--primary`, `--primary-foreground` | `--color-primary`, `--color-on-primary` |',
    '| `--secondary`, `--accent` | `--color-surface-raised` (hover and selected surfaces) |',
    '| `--muted-foreground` | `--color-text-muted` |',
    '| `--destructive` | `--color-danger` |',
    '| `--border`, `--input`, `--ring` | `--color-border`, `--color-border-strong`, `--color-focus` |',
    '| `--highlight`, `--highlight-foreground` | `--color-accent`, `--color-on-accent` |',
    '',
    "Careful with the names: shadcn's `accent` is a hover background, not this system's accent colour. Use `bg-highlight` (or the Badge's `highlight` variant) for the accent, never `bg-accent`.",
    ''
  ]
}
