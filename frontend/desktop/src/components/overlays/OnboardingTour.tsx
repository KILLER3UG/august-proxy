/* ── OnboardingTour — 4-step first-run overlay (D10) ──────────────────── */
/* Skippable; persists completion so it only shows once. Each step links
 * into the real surfaces instead of faking them. */

import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, Bot, Check, Gavel, Rocket, Sparkles, X } from 'lucide-react';
import { useSessionsStore } from '@/store/sessions';

const DONE_KEY = 'august_onboarding_done';

export function shouldShowOnboarding(): boolean {
  try {
    return localStorage.getItem(DONE_KEY) !== '1';
  } catch {
    return false;
  }
}

interface TourStep {
  icon: typeof Sparkles;
  title: string;
  body: string;
  action?: { label: string; to: string };
}

const STEPS: TourStep[] = [
  {
    icon: Sparkles,
    title: 'Welcome',
    body: 'A harness that learns you — it remembers your preferences, tracks which models actually win your tasks, and runs arena comparisons and debates so you always pick the best answer.',
  },
  {
    icon: Bot,
    title: 'Connect a provider',
    body: 'Model-agnostic: Anthropic, OpenAI, DeepSeek, local Ollama — anything. One model is fine; routing roles are optional extras.',
    action: { label: 'Add a provider', to: '/settings/model-providers' },
  },
  {
    icon: Rocket,
    title: 'Try the harness',
    body: 'Start a chat, or press Parallel to compare 2–3 models on the same prompt, or Debate to have two models argue it out.',
    action: { label: 'Start a chat', to: '/c/new' },
  },
  {
    icon: Gavel,
    title: 'See what it knows',
    body: 'The Brain → You tab shows your profile, learned rules, friction, and each model’s track record. Everything is editable — this is your harness.',
    action: { label: 'Open the Brain', to: '/brain?tab=you' },
  },
] as const;

export function OnboardingTour() {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(0);
  const navigate = useNavigate();
  const sessionCount = useSessionsStore((s) => s.sessions.length);

  useEffect(() => {
    // Show when the app is truly fresh: no sessions yet and not dismissed.
    if (shouldShowOnboarding() && sessionCount === 0) {
      const timer = setTimeout(() => setOpen(true), 1200);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [sessionCount]);

  if (!open) return null;

  const finish = () => {
    try {
      localStorage.setItem(DONE_KEY, '1');
    } catch {
      /* ignore */
    }
    setOpen(false);
  };

  const stepData = STEPS[step];
  const Icon = stepData.icon;
  const last = step === STEPS.length - 1;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Welcome"
      data-testid="onboarding-tour"
    >
      <div className="w-full max-w-md rounded-xl border border-border bg-popover p-5 shadow-xl space-y-4">
        <div className="flex items-center gap-2">
          <Icon className="size-5 text-primary" />
          <h2 className="text-base font-semibold">{stepData.title}</h2>
          <span className="ml-auto text-[10px] text-muted-foreground">
            {step + 1}/{STEPS.length}
          </span>
          <button
            type="button"
            onClick={finish}
            className="p-1 text-muted-foreground hover:text-foreground"
            aria-label="Skip onboarding"
          >
            <X className="size-4" />
          </button>
        </div>

        <p className="text-xs text-muted-foreground leading-relaxed">{stepData.body}</p>

        <div className="flex items-center justify-between pt-1">
          <div className="flex gap-1">
            {STEPS.map((_, i) => (
              <span
                key={i}
                className={`h-1 w-4 rounded-full ${i <= step ? 'bg-primary' : 'bg-muted'}`}
              />
            ))}
          </div>
          <div className="flex gap-2">
            {step > 0 ? (
              <button
                type="button"
                onClick={() => setStep((s) => s - 1)}
                className="text-xs px-3 py-1.5 rounded bg-muted text-muted-foreground"
              >
                Back
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => {
                if ('action' in stepData && stepData.action) {
                  navigate(stepData.action.to);
                }
                if (last) {
                  finish();
                } else {
                  setStep((s) => s + 1);
                }
              }}
              className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground"
              data-testid="onboarding-next"
            >
              {last ? (
                <>
                  <Check className="size-3" />
                  Get started
                </>
              ) : (
                <>
                  {stepData.action?.label ?? 'Next'}
                  <ArrowRight className="size-3" />
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
