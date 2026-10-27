import { cva, type VariantProps } from 'class-variance-authority';
import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-md text-xs font-medium whitespace-nowrap transition outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-3',
  {
    variants: {
      variant: {
        default:    'bg-primary text-primary-foreground hover:bg-primary/90',
        destructive:'bg-destructive text-destructive-foreground hover:bg-destructive/90',
        outline:    'border border-border bg-background hover:bg-accent hover:text-accent-foreground',
        secondary:  'bg-secondary text-secondary-foreground hover:bg-secondary/80',
        ghost:      'hover:bg-accent hover:text-accent-foreground',
        link:       'text-primary underline-offset-4 hover:underline',
        /* No layout, type or colour: the control's whole appearance comes from
         * a stylesheet (the Signal Desk port in styles/signal-desk.css). What
         * survives is what the primitive is FOR here — the focus ring, the
         * pointer, and the disabled states — so a stylesheet-styled button is
         * still a Button rather than a raw <button> that has to re-earn them. */
        bare:       '',
      },
      size: {
        default:   'px-3 py-1.5',
        sm:        'px-2.5 py-1',
        lg:        'px-4 py-2',
        icon:      'size-9',
        'icon-sm': 'size-7',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>,
  VariantProps<typeof buttonVariants> {}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button({ className, variant, size, ...props }, ref) {
    if (variant === 'bare') {
      return (
        <button
          ref={ref}
          className={cn(
            'cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:pointer-events-none disabled:opacity-50',
            className,
          )}
          {...props}
        />
      );
    }
    return (
      <button
        ref={ref}
        className={cn(buttonVariants({ variant, size }), className)}
        {...props}
      />
    );
  },
);
// eslint-disable-next-line react-refresh/only-export-components
export { buttonVariants };
