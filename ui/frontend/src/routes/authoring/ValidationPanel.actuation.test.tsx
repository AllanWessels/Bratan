import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { SeedValidateResponse } from "@/api/types";

import { ValidationPanel } from "./ValidationPanel";

/**
 * Drives the only interactive control in the panel — the "Also run
 * through pipeline" checkbox — through full on/off cycles and asserts
 * the parent callback fires with the new value each time.
 */

function emptyResult(): SeedValidateResponse {
  return {
    passages_in_top_k: false,
    answer_text_in_passages: false,
    top_k_match_count: 0,
    top_k_searched: 0,
    pipeline_score: null,
    pipeline_answer: null,
    pipeline_retrieved: null,
    warnings: [],
  };
}

describe("ValidationPanel actuation — pipeline toggle", () => {
  it("clicking the pipeline toggle fires onToggleRunPipeline(true) on first click", async () => {
    const onToggle = vi.fn();
    const user = userEvent.setup();
    render(
      <ValidationPanel
        result={null}
        isLoading={false}
        isError={false}
        runPipeline={false}
        onToggleRunPipeline={onToggle}
      />,
    );
    await user.click(screen.getByRole("checkbox"));
    expect(onToggle).toHaveBeenCalledWith(true);
  });

  it("when runPipeline is already true, the checkbox is rendered checked", () => {
    render(
      <ValidationPanel
        result={null}
        isLoading={false}
        isError={false}
        runPipeline={true}
        onToggleRunPipeline={vi.fn()}
      />,
    );
    expect(screen.getByRole("checkbox")).toBeChecked();
  });

  it("when runPipeline is already true, clicking it fires onToggleRunPipeline(false)", async () => {
    const onToggle = vi.fn();
    const user = userEvent.setup();
    render(
      <ValidationPanel
        result={null}
        isLoading={false}
        isError={false}
        runPipeline={true}
        onToggleRunPipeline={onToggle}
      />,
    );
    await user.click(screen.getByRole("checkbox"));
    expect(onToggle).toHaveBeenCalledWith(false);
  });

  it("rendering a partial result with warnings still keeps the toggle wired up", async () => {
    const r = emptyResult();
    r.warnings = ["A warning"];
    const onToggle = vi.fn();
    const user = userEvent.setup();
    render(
      <ValidationPanel
        result={r}
        isLoading={false}
        isError={false}
        runPipeline={false}
        onToggleRunPipeline={onToggle}
      />,
    );
    expect(screen.getByText(/A warning/)).toBeInTheDocument();
    await user.click(screen.getByRole("checkbox"));
    expect(onToggle).toHaveBeenCalledWith(true);
  });
});
