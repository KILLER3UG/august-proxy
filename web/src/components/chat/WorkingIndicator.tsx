import { motion } from 'framer-motion';

interface WorkingIndicatorProps {
  className?: string;
}

export function WorkingIndicator({ className }: WorkingIndicatorProps) {
  return (
    <div className={cn("flex items-center gap-0.5 py-1", className)}>
      {['A', 'u', 'g'].map((char, i) => (
        <motion.span
          key={i}
          className="text-lg font-bold text-primary inline-block"
          animate={{ opacity: [0, 1, 1, 0], y: [4, 0, 0, 4] }}
          transition={{ duration: 1.8, repeat: Infinity, ease: "easeInOut", delay: i * 0.25, times: [0, 0.15, 0.7, 1] }}
        >
          {char}
        </motion.span>
      ))}
      <motion.span
        className="text-lg font-bold text-primary/50 inline-block"
        animate={{ opacity: [1, 0] }}
        transition={{ duration: 0.8, repeat: Infinity, ease: "linear" }}
      >
        |
      </motion.span>
    </div>
  );
}

function cn(...classes: (string | undefined | null | false)[]) {
  return classes.filter(Boolean).join(' ');
}
