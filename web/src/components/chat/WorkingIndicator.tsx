import { motion } from 'framer-motion';

interface WorkingIndicatorProps {
  className?: string;
}

export function WorkingIndicator({ className }: WorkingIndicatorProps) {
  return (
    <div className={cn("flex items-center gap-1.5", className)}>
      <motion.span
        className="text-sm font-bold text-primary"
        animate={{
          y: [0, -4, 0],
          opacity: [0.6, 1, 0.6],
        }}
        transition={{
          duration: 0.8,
          repeat: Infinity,
          ease: "easeInOut",
        }}
      >
        A
      </motion.span>
      <motion.span
        className="text-sm font-bold text-primary/60"
        animate={{
          y: [0, -3, 0],
          opacity: [0.4, 0.8, 0.4],
        }}
        transition={{
          duration: 0.8,
          repeat: Infinity,
          ease: "easeInOut",
          delay: 0.1,
        }}
      >
        u
      </motion.span>
      <motion.span
        className="text-sm font-bold text-primary/40"
        animate={{
          y: [0, -2, 0],
          opacity: [0.3, 0.6, 0.3],
        }}
        transition={{
          duration: 0.8,
          repeat: Infinity,
          ease: "easeInOut",
          delay: 0.2,
        }}
      >
        g
      </motion.span>
      <motion.span
        className="text-sm font-bold text-primary/30"
        animate={{
          y: [0, -1, 0],
          opacity: [0.2, 0.5, 0.2],
        }}
        transition={{
          duration: 0.8,
          repeat: Infinity,
          ease: "easeInOut",
          delay: 0.3,
        }}
      >
        .
      </motion.span>
    </div>
  );
}

function cn(...classes: (string | undefined | null | false)[]) {
  return classes.filter(Boolean).join(' ');
}
