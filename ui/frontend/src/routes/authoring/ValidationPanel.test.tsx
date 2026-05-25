import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { SeedValidateResponse } from "@/api/types";

import { ValidationPanel } from "./ValidationPanel";

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

describe("ValidationPanel", () => {
  it("renders the empty/initial prompt when result is null", () => {
    render(
      <ValidationPanel
        result={null}
        isLoading={false}
        isError={false}
        runPipeline={false}
        onToggleRunPipeline={vi.fn()}
      />,
    );
    expect(screen.getByText(/Add a question, passages/i)).toBeInTheDocument();
  });

  it("renders a loading indicator while validating", () => {
    render(
      <ValidationPanel
        result={null}
        isLoading={true}
        isError={false}
        runPipeline={false}
        onToggleRunPipeline={vi.fn()}
      />,
    );
    expect(screen.getByText(/Validating/i)).toBeInTheDocument();
  });

  it("renders an error message when isError is true", () => {
    render(
      <ValidationPanel
        result={null}
        isLoading={false}
        isError={true}
        errorMessage="backend exploded"
        runPipeline={false}
        onToggleRunPipeline={vi.fn()}
      />,
    );
    expect(screen.getByText("backend exploded")).toBeInTheDocument();
  });

  it("renders both checkmark rows for a valid result", () => {
    const r = emptyResult();
    r.passages_in_top_k = true;
    r.answer_text_in_passages = true;
    r.top_k_match_count = 2;
    r.top_k_searched = 5;
    render(
      <ValidationPanel
        result={r}
        isLoading={false}
        isError={false}
        runPipeline={false}
        onToggleRunPipeline={vi.fn()}
      />,
    );
    // New ValidationPanel (5ba5d55): retrieval row label changed from
    // "Passages retrievable in top-5" to "Pipeline retrieves this passage";
    // verbatim row from "Answer text appears in selected passages" to
    // "Answer appears verbatim in passages"; data-valid attribute replaced
    // with data-difficulty enum ("easy" | "hard" | "inference" | "adversarial").
    expect(screen.getByText(/Pipeline retrieves this passage/i)).toBeInTheDocument();
    expect(screen.getByText(/Answer appears verbatim in passages/i)).toBeInTheDocument();
    expect(screen.getByText(/2 of 5 selected passages found/i)).toBeInTheDocument();
    expect(screen.getByText(/Substring match confirmed/i)).toBeInTheDocument();
    expect(screen.getByTestId("validation-result")).toHaveAttribute(
      "data-difficulty",
      "easy",
    );
    expect(screen.getByTestId("validation-difficulty-badge")).toHaveTextContent(
      /Easy case/i,
    );
  });

  it("renders X rows for an invalid result", () => {
    const r = emptyResult();
    render(
      <ValidationPanel
        result={r}
        isLoading={false}
        isError={false}
        runPipeline={false}
        onToggleRunPipeline={vi.fn()}
      />,
    );
    // Both signals fail → adversarial difficulty (hard case worth keeping in
    // the seed set). New copy is descriptive, not punitive.
    expect(screen.getByTestId("validation-result")).toHaveAttribute(
      "data-difficulty",
      "adversarial",
    );
    expect(screen.getByTestId("validation-difficulty-badge")).toHaveTextContent(
      /Hard case \(adversarial\)/i,
    );
    expect(
      screen.getByText(/Not a verbatim match — answer is inferred or paraphrased/i),
    ).toBeInTheDocument();
  });

  it("renders the warnings list when warnings are present", () => {
    const r = emptyResult();
    r.warnings = ["Ground truth is suspiciously short", "Question contains a pronoun"];
    render(
      <ValidationPanel
        result={r}
        isLoading={false}
        isError={false}
        runPipeline={false}
        onToggleRunPipeline={vi.fn()}
      />,
    );
    expect(screen.getByText(/Ground truth is suspiciously short/)).toBeInTheDocument();
    expect(screen.getByText(/Question contains a pronoun/)).toBeInTheDocument();
  });

  it("renders the pipeline-run block when pipeline_score is set", () => {
    const r = emptyResult();
    r.pipeline_score = 0.73;
    r.pipeline_answer = "The judge runs at temperature zero.";
    render(
      <ValidationPanel
        result={r}
        isLoading={false}
        isError={false}
        runPipeline={true}
        onToggleRunPipeline={vi.fn()}
      />,
    );
    expect(screen.getByText(/0\.73/)).toBeInTheDocument();
    expect(screen.getByText(/temperature zero/)).toBeInTheDocument();
  });

  it("fires onToggleRunPipeline when the checkbox is toggled", async () => {
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
    const checkbox = screen.getByRole("checkbox");
    await user.click(checkbox);
    expect(onToggle).toHaveBeenCalledWith(true);
  });
});
