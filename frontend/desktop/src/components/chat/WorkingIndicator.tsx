import { motion } from 'framer-motion';

interface WorkingIndicatorProps {
  className?: string;
}

export function WorkingIndicator({ className }: WorkingIndicatorProps) {
  return (
    <div
      className={cn('flex items-center gap-0.5 py-1', className)}
      role="status"
      aria-live="polite"
      aria-label="August is working"
    >
      {['A', 'U', 'G'].map((char, i) => (
        <motion.span
          key={char}
          className="text-lg font-bold text-primary inline-block"
          initial={{ opacity: 0.35, y: 2 }}
          animate={{ opacity: [0.35, 1, 1, 0.35], y: [2, 0, 0, 2] }}
          transition={{
            duration: 1.8,
            repeat: Infinity,
            ease: 'easeInOut',
            delay: i * 0.25,
            times: [0, 0.15, 0.7, 1],
          }}
        >
          {char}
        </motion.span>
      ))}
      <motion.span
        className="text-lg font-bold text-primary/50 inline-block"
        animate={{ opacity: [1, 0.15, 1] }}
        transition={{ duration: 0.8, repeat: Infinity, ease: 'linear' }}
      >
        |
      </motion.span>
    </div>
  );
}

function cn(...classes: (string | undefined | null | false)[]) {
  return classes.filter(Boolean).join(' ');
}
