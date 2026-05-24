import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { SeedCase } from "@/api/types";
import type { GeneratedFileSummary } from "@/api/types-generated";

const mocks = vi.hoisted(() => ({
  useGeneratedFiles: vi.fn(),
  useGeneratedCases: vi.fn(),
}));

vi.mock("@/api/hooks", () => mocks);

import { GeneratedList } from "./GeneratedList";

function withProviders(ui: React.ReactNode) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

const fileA: GeneratedFileSummary = {
  timestamp: "2026-05-23T12-00-00Z",
  n_cases: 3,
  file_path: "test_cases/generated/2026-05-23T12-00-00Z.jsonl",
};

const fileB: GeneratedFileSummary = {
  timestamp: "2026-05-22T09-00-00Z",
  n_cases: 1,
  file_path: "test_cases/generated/2026-05-22T09-00-00Z.jsonl",
};

const caseA: SeedCase = {
  id: "rt-001",
  question: "What is the airspeed of an unladen swallow?",
  ground_truth: "African or European?",
  source_passages: [{ path: "monty.md", line_start: 1, line_end: 3 }],
  failure_category: "disambiguation",
  notes: "",
  hypothesis: null,
  created_at: "2026-05-23T12:00:00Z",
  created_by: "red-team",
};

beforeEach(() => {
  mocks.useGeneratedFiles.mockReturnValue({
    data: [],
    isLoading: false,
    isError: false,
  });
  mocks.useGeneratedCases.mockReturnValue({
    data: [],
    isLoading: false,
    isError: false,
  });
});

describe("GeneratedList", () => {
  it("renders empty-state message when there are no generated batches", () => {
    render(withProviders(<GeneratedList />));
    expect(screen.getByTestId("generated-empty")).toBeInTheDocument();
    expect(
      screen.getByText(/No red-team batches yet/i),
    ).toBeInTheDocument();
  });

  it("renders one row per generated file with timestamp and case count", () => {
    mocks.useGeneratedFiles.mockReturnValue({
      data: [fileA, fileB],
      isLoading: false,
      isError: false,
    });
    render(withProviders(<GeneratedList />));
    expect(screen.getByText(fileA.timestamp)).toBeInTheDocument();
    expect(screen.getByText(fileB.timestamp)).toBeInTheDocument();
    expect(screen.getByText(/3 cases/i)).toBeInTheDocument();
    // singular form for 1
    expect(screen.getByText(/^1 case$/i)).toBeInTheDocument();
  });

  it("expands a file when clicked, revealing its cases (question + category)", async () => {
    mocks.useGeneratedFiles.mockReturnValue({
      data: [fileA],
      isLoading: false,
      isError: false,
    });
    mocks.useGeneratedCases.mockReturnValue({
      data: [caseA],
      isLoading: false,
      isError: false,
    });
    const user = userEvent.setup();
    render(withProviders(<GeneratedList />));

    // The toggle row has the timestamp text; clicking it expands.
    const toggle = screen.getByRole("button", { name: new RegExp(fileA.timestamp) });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");

    expect(screen.getByText(caseA.question)).toBeInTheDocument();
    expect(screen.getByText(caseA.failure_category)).toBeInTheDocument();
    // The case container is the data-testid'd region.
    expect(
      screen.getByTestId(`generated-cases-${fileA.timestamp}`),
    ).toBeInTheDocument();
  });

  it("is read-only — no edit or delete affordances are rendered", async () => {
    mocks.useGeneratedFiles.mockReturnValue({
      data: [fileA],
      isLoading: false,
      isError: false,
    });
    mocks.useGeneratedCases.mockReturnValue({
      data: [caseA],
      isLoading: false,
      isError: false,
    });
    const user = userEvent.setup();
    render(withProviders(<GeneratedList />));
    await user.click(
      screen.getByRole("button", { name: new RegExp(fileA.timestamp) }),
    );
    // No "Discard", "Delete", "Edit", or "Save" button should appear.
    expect(screen.queryByRole("button", { name: /discard|delete|edit|save/i })).toBeNull();
    // No textbox inputs either.
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("collapsing a previously-expanded file hides its cases again", async () => {
    mocks.useGeneratedFiles.mockReturnValue({
      data: [fileA],
      isLoading: false,
      isError: false,
    });
    mocks.useGeneratedCases.mockReturnValue({
      data: [caseA],
      isLoading: false,
      isError: false,
    });
    const user = userEvent.setup();
    render(withProviders(<GeneratedList />));

    const toggle = screen.getByRole("button", { name: new RegExp(fileA.timestamp) });
    await user.click(toggle);
    expect(screen.getByText(caseA.question)).toBeInTheDocument();
    await user.click(toggle);
    expect(screen.queryByText(caseA.question)).not.toBeInTheDocument();
    expect(toggle).toHaveAttribute("aria-expanded", "false");
  });
});
