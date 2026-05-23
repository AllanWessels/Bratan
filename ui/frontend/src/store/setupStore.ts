import { create } from "zustand";
import type { BratanConfig } from "@/api/types";

export type StepNum = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

interface SetupStoreState {
  currentStep: StepNum;
  draft: Partial<BratanConfig> | null;
  setCurrentStep: (s: StepNum) => void;
  setDraft: (d: Partial<BratanConfig> | null) => void;
  patchDraft: (patch: Partial<BratanConfig>) => void;
}

export const useSetupStore = create<SetupStoreState>((set) => ({
  currentStep: 1,
  draft: null,
  setCurrentStep: (s) => set({ currentStep: s }),
  setDraft: (d) => set({ draft: d }),
  patchDraft: (patch) =>
    set((s) => ({
      draft: { ...(s.draft ?? {}), ...patch } as Partial<BratanConfig>,
    })),
}));

export const STEP_TITLES: Record<StepNum, string> = {
  1: "Project basics",
  2: "Vector database",
  3: "Models",
  4: "Cost ceilings",
  5: "Seed target",
  6: "GPU detection",
  7: "Stopping criteria",
  8: "Judge weights",
};
