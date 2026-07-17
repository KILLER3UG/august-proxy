/**
 * Animated setup plan for first-launch backend bootstrap.
 * Motion language adapted from the agent-plan pattern (framer-motion + lucide status icons).
 */
import { useMemo, useState, useEffect } from 'react';
import {
  CheckCircle2,
  Circle,
  CircleAlert,
  CircleDotDashed,
  CircleX,
} from 'lucide-react';
import { motion, AnimatePresence, LayoutGroup } from 'framer-motion';
import {
  SETUP_STEPS,
  setupStepIndex,
  type BackendSetupPhase,
} from '@/hooks/useBackendSetup';

type StepStatus = 'completed' | 'in-progress' | 'pending' | 'failed';

function stepStatus(phase: string, idx: number, activeIdx: number): StepStatus {
  if (phase === 'error' && idx === Math.max(activeIdx, 0)) return 'failed';
  if (phase === 'ready' || (activeIdx >= 0 && idx < activeIdx)) return 'completed';
  if (activeIdx === idx) return 'in-progress';
  return 'pending';
}

function StatusIcon({ status, size = 'md' }: { status: StepStatus; size?: 'sm' | 'md' }) {
  const cls = size === 'sm' ? 'h-3.5 w-3.5' : 'h-4.5 w-4.5';
  if (status === 'completed') return <CheckCircle2 className={`${cls} text-green-500`} />;
  if (status === 'in-progress') return <CircleDotDashed className={`${cls} text-blue-500`} />;
  if (status === 'failed') return <CircleX className={`${cls} text-red-500`} />;
  return <Circle className={`text-muted-foreground ${cls}`} />;
}

function statusBadgeClass(status: StepStatus): string {
  if (status === 'completed') return 'bg-green-500/15 text-green-400';
  if (status === 'in-progress') return 'bg-blue-500/15 text-blue-400';
  if (status === 'failed') return 'bg-red-500/15 text-red-400';
  return 'bg-muted text-muted-foreground';
}

const STEP_DETAILS: Record<string, string> = {
  copying: 'Copying portable Python and backend sources into AppData.',
  creating_venv: 'Creating a private virtual environment for the runtime.',
  installing: 'Installing packages offline from bundled wheels.',
  starting: 'Launching uvicorn and waiting for /api/health.',
  ready: 'Backend is healthy and ready for chat.',
};

export function BackendSetupPlan({
  setup,
  headline,
  detail,
}: {
  setup: BackendSetupPhase;
  headline: string;
  detail: string;
}) {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);
  const activeIdx = setupStepIndex(setup.phase);
  const overallStatus: StepStatus =
    setup.phase === 'ready'
      ? 'completed'
      : setup.phase === 'error'
        ? 'failed'
        : activeIdx >= 0 || setup.phase === 'starting' || setup.phase === 'idle'
          ? 'in-progress'
          : 'pending';

  useEffect(() => {
    if (typeof window === 'undefined') return;
    setPrefersReducedMotion(window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }, []);

  const ease = [0.2, 0.65, 0.3, 0.9] as const;

  const taskVariants = useMemo(
    () => ({
      hidden: { opacity: 0, y: prefersReducedMotion ? 0 : -5 },
      visible: {
        opacity: 1,
        y: 0,
        transition: {
          type: prefersReducedMotion ? ('tween' as const) : ('spring' as const),
          stiffness: 500,
          damping: 30,
          duration: prefersReducedMotion ? 0.2 : undefined,
        },
      },
    }),
    [prefersReducedMotion],
  );

  const subtaskListVariants = {
    hidden: { opacity: 0, height: 0, overflow: 'hidden' as const },
    visible: {
      height: 'auto' as const,
      opacity: 1,
      overflow: 'visible' as const,
      transition: {
        duration: 0.25,
        staggerChildren: prefersReducedMotion ? 0 : 0.05,
        when: 'beforeChildren' as const,
        ease,
      },
    },
  };

  const subtaskVariants = {
    hidden: { opacity: 0, x: prefersReducedMotion ? 0 : -10 },
    visible: {
      opacity: 1,
      x: 0,
      transition: {
        type: prefersReducedMotion ? ('tween' as const) : ('spring' as const),
        stiffness: 500,
        damping: 25,
        duration: prefersReducedMotion ? 0.2 : undefined,
      },
    },
  };

  const statusBadgeVariants = {
    initial: { scale: 1 },
    animate: {
      scale: prefersReducedMotion ? 1 : [1, 1.08, 1],
      transition: {
        duration: 0.35,
        ease: [0.34, 1.56, 0.64, 1] as const,
      },
    },
  };

  return (
    <motion.div
      className="bg-card border-border w-[min(90vw,440px)] overflow-hidden rounded-lg border shadow-2xl"
      initial={{ opacity: 0, y: 10 }}
      animate={{
        opacity: 1,
        y: 0,
        transition: { duration: 0.3, ease },
      }}
      role="status"
      aria-live="polite"
      aria-label={headline}
    >
      <LayoutGroup>
        <div className="overflow-hidden p-4">
          <motion.div className="mb-3 px-1" variants={taskVariants} initial="hidden" animate="visible">
            <div className="flex items-start gap-2.5">
              <AnimatePresence mode="wait">
                <motion.div
                  key={overallStatus}
                  initial={{ opacity: 0, scale: 0.8, rotate: -10 }}
                  animate={{ opacity: 1, scale: 1, rotate: 0 }}
                  exit={{ opacity: 0, scale: 0.8, rotate: 10 }}
                  transition={{ duration: 0.2, ease }}
                  className="mt-0.5"
                >
                  {overallStatus === 'failed' ? (
                    <CircleAlert className="h-5 w-5 text-yellow-500" />
                  ) : (
                    <StatusIcon status={overallStatus} />
                  )}
                </motion.div>
              </AnimatePresence>
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <h2 className="text-sm font-semibold tracking-tight text-foreground">{headline}</h2>
                  <motion.span
                    key={overallStatus}
                    className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${statusBadgeClass(overallStatus)}`}
                    variants={statusBadgeVariants}
                    initial="initial"
                    animate="animate"
                  >
                    {overallStatus}
                  </motion.span>
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">{detail}</p>
              </div>
            </div>
          </motion.div>

          <motion.div
            className="relative overflow-hidden"
            variants={subtaskListVariants}
            initial="hidden"
            animate="visible"
          >
            <div className="absolute bottom-0 left-[18px] top-0 border-l-2 border-dashed border-muted-foreground/30" />
            <ul className="ml-1 space-y-0.5">
              {SETUP_STEPS.map((step, idx) => {
                const status = stepStatus(setup.phase, idx, activeIdx);
                const isCurrent = status === 'in-progress';
                const description = STEP_DETAILS[step.id] ?? '';

                return (
                  <motion.li
                    key={step.id}
                    className="group flex flex-col py-0.5 pl-6"
                    variants={subtaskVariants}
                    layout
                  >
                    <motion.div
                      className="flex flex-1 items-center rounded-md p-1.5"
                      animate={
                        isCurrent && !prefersReducedMotion
                          ? { backgroundColor: 'rgba(255,255,255,0.04)' }
                          : { backgroundColor: 'rgba(0,0,0,0)' }
                      }
                      transition={{ duration: 0.2 }}
                      layout
                    >
                      <motion.div
                        className="mr-2 flex-shrink-0"
                        whileHover={prefersReducedMotion ? undefined : { scale: 1.1 }}
                        layout
                      >
                        <AnimatePresence mode="wait">
                          <motion.div
                            key={status}
                            initial={{ opacity: 0, scale: 0.8, rotate: -10 }}
                            animate={{ opacity: 1, scale: 1, rotate: 0 }}
                            exit={{ opacity: 0, scale: 0.8, rotate: 10 }}
                            transition={{ duration: 0.2, ease }}
                          >
                            <StatusIcon status={status} size="sm" />
                          </motion.div>
                        </AnimatePresence>
                      </motion.div>

                      <span
                        className={`flex-1 text-sm ${
                          status === 'completed' ? 'text-muted-foreground line-through' : ''
                        } ${isCurrent ? 'font-medium text-foreground' : ''}`}
                      >
                        {step.label}
                      </span>

                      <motion.span
                        key={`${step.id}-${status}`}
                        className={`ml-2 rounded px-1.5 py-0.5 text-[10px] font-medium ${statusBadgeClass(status)}`}
                        variants={statusBadgeVariants}
                        initial="initial"
                        animate="animate"
                      >
                        {status}
                      </motion.span>
                    </motion.div>

                    <AnimatePresence mode="wait">
                      {isCurrent && description ? (
                        <motion.div
                          className="text-muted-foreground border-foreground/20 ml-1.5 mt-0.5 overflow-hidden border-l border-dashed pl-5 text-xs"
                          initial={{ opacity: 0, height: 0 }}
                          animate={{
                            opacity: 1,
                            height: 'auto',
                            transition: { duration: 0.25, ease },
                          }}
                          exit={{ opacity: 0, height: 0, transition: { duration: 0.15 } }}
                          layout
                        >
                          <p className="py-1">{description}</p>
                          {setup.detail && (
                            <p className="pb-1 text-[11px] text-muted-foreground/80">{setup.detail}</p>
                          )}
                        </motion.div>
                      ) : null}
                    </AnimatePresence>
                  </motion.li>
                );
              })}
            </ul>
          </motion.div>
        </div>
      </LayoutGroup>
    </motion.div>
  );
}
