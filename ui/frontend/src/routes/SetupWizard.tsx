import { useEffect, useMemo } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ChevronLeft, ChevronRight, FastForward } from "lucide-react";
import { Button } from "@/components/Button";
import { StepIndicator } from "@/components/StepIndicator";
import { Spinner } from "@/components/Spinner";
import { useConfig, useFinishSetup, useSetupState } from "@/api/hooks";
import { STEP_TITLES, useSetupStore, type StepNum } from "@/store/setupStore";
import { useUIStore } from "@/store/uiStore";
import { Step1ProjectBasics } from "./setup/Step1ProjectBasics";
import { Step2VectorDB } from "./setup/Step2VectorDB";
import { Step3Models } from "./setup/Step3Models";
import { Step4Costs } from "./setup/Step4Costs";
import { Step5SeedTarget } from "./setup/Step5SeedTarget";
import { Step6GPU } from "./setup/Step6GPU";
import { Step7Stopping } from "./setup/Step7Stopping";
import { Step8JudgeWeights } from "./setup/Step8JudgeWeights";

const TOTAL_STEPS = 8;

function parseStep(raw: string | undefined): StepNum {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1 || n > TOTAL_STEPS) return 1;
  return n as StepNum;
}

export function SetupWizard() {
  const params = useParams<{ step?: string }>();
  const navigate = useNavigate();
  const step = parseStep(params.step);
  const setCurrentStep = useSetupStore((s) => s.setCurrentStep);
  const setupState = useSetupState();
  const cfg = useConfig({ retry: false });
  const finishMutation = useFinishSetup();
  const pushToast = useUIStore((s) => s.pushToast);

  useEffect(() => {
    setCurrentStep(step);
  }, [step, setCurrentStep]);

  const completed = setupState.data?.completed_steps ?? [];

  const onNext = () => {
    if (step < TOTAL_STEPS) {
      navigate(`/setup/${step + 1}`);
    } else {
      void finishMutation.mutateAsync().then(() => {
        pushToast("Setup complete", "success");
        navigate("/authoring", { replace: true });
      });
    }
  };

  const onPrev = () => {
    if (step > 1) navigate(`/setup/${step - 1}`);
  };

  const onSkip = () => {
    void finishMutation.mutateAsync().then(() => {
      pushToast("Setup completed with defaults", "success");
      navigate("/authoring", { replace: true });
    });
  };

  const StepComponent = useMemo(() => {
    switch (step) {
      case 1:
        return Step1ProjectBasics;
      case 2:
        return Step2VectorDB;
      case 3:
        return Step3Models;
      case 4:
        return Step4Costs;
      case 5:
        return Step5SeedTarget;
      case 6:
        return Step6GPU;
      case 7:
        return Step7Stopping;
      case 8:
        return Step8JudgeWeights;
    }
  }, [step]);

  if (setupState.isLoading || cfg.isLoading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <Spinner size="lg" />
      </div>
    );
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-7xl gap-8 px-6 py-10">
      <aside className="w-64 shrink-0">
        <div className="sticky top-10">
          <Link to="/" className="mb-6 block">
            <h1 className="text-xl font-semibold text-slate-900">RAG Refiner</h1>
            <p className="text-sm text-slate-500">Setup wizard</p>
          </Link>
          <StepIndicator current={step} completed={completed} />
          <div className="mt-6 border-t border-slate-200 pt-4">
            <Button
              variant="ghost"
              size="sm"
              className="w-full justify-start text-slate-600"
              onClick={onSkip}
              loading={finishMutation.isPending}
            >
              <FastForward className="h-4 w-4" />
              Skip to defaults
            </Button>
          </div>
        </div>
      </aside>

      <main className="flex-1">
        <header className="mb-6">
          <p className="text-sm font-medium text-brand-600">
            Step {step} of {TOTAL_STEPS}
          </p>
          <h2 className="mt-1 text-2xl font-semibold text-slate-900">{STEP_TITLES[step]}</h2>
        </header>

        {StepComponent && <StepComponent config={cfg.data ?? null} />}

        <div className="mt-8 flex items-center justify-between">
          <Button variant="secondary" onClick={onPrev} disabled={step === 1}>
            <ChevronLeft className="h-4 w-4" />
            Previous
          </Button>
          <Button onClick={onNext} loading={finishMutation.isPending}>
            {step === TOTAL_STEPS ? "Finish setup" : "Next"}
            {step !== TOTAL_STEPS && <ChevronRight className="h-4 w-4" />}
          </Button>
        </div>
      </main>
    </div>
  );
}
