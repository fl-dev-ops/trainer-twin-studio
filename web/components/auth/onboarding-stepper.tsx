"use client";

import { cn } from "@/lib/utils";

export function OnboardingProgress({
  currentStep,
  onStepClick,
  className,
}: {
  currentStep: 1 | 2 | 3;
  onStepClick?: (step: 1 | 2 | 3) => void;
  className?: string;
}) {
  return (
    <nav
      aria-label="Onboarding Progress"
      className={cn("flex items-center gap-2 mb-6 select-none", className)}
    >
      {[1, 2, 3].map((stepNumber) => {
        const isActive = stepNumber <= currentStep;
        const isCompleted = stepNumber < currentStep;

        return (
          <button
            key={stepNumber}
            type="button"
            onClick={() => {
              if (isCompleted && onStepClick) {
                onStepClick(stepNumber as 1 | 2 | 3);
              }
            }}
            disabled={!isCompleted || !onStepClick}
            aria-label={`Step ${stepNumber} of 3`}
            aria-current={stepNumber === currentStep ? "step" : undefined}
            className={cn(
              "h-1 w-9 sm:w-11 rounded-full transition-all duration-300",
              isActive ? "bg-primary" : "bg-zinc-200 dark:bg-zinc-800",
              isCompleted && onStepClick
                ? "cursor-pointer hover:opacity-80"
                : "cursor-default",
            )}
          />
        );
      })}
    </nav>
  );
}

// Alias for backwards compatibility
export const OnboardingStepper = OnboardingProgress;
