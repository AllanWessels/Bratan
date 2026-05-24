import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Passage } from "@/api/types";

const mocks = vi.hoisted(() => ({
  useCorpusSearch: vi.fn(),
}));

vi.mock("@/api/hooks", () => mocks);

import { PassagePicker } from "./PassagePicker";

function withProviders(ui: React.ReactNode) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

const passageA: Passage = {
  path: "intro.md",
  line_start: 1,
  line_end: 5,
  content: "This is a long passage explaining things. ".repeat(8),
  score: 0.876,
};
const passageB: Passage = {
  path: "guide.md",
  line_start: 10,
  line_end: 15,
  content: "Another passage with detail.",
  score: 0.5,
};

beforeEach(() => {
  mocks.useCorpusSearch.mockReturnValue({
    mutate: vi.fn(),
    data: null,
    isPending: false,
    isError: false,
    error: null,
  });
});

describe("PassagePicker", () => {
  it("renders empty-state when query is shorter than 3 chars", () => {
    render(
      withProviders(
        <PassagePicker
          query="hi"
          selected={[]}
          onAdd={vi.fn()}
          onRemove={vi.fn()}
        />,
      ),
    );
    expect(screen.getByText(/Type a question above/i)).toBeInTheDocument();
  });

  it("renders the results list when corpus_search returns passages", async () => {
    mocks.useCorpusSearch.mockReturnValue({
      mutate: vi.fn(),
      data: {
        passages: [passageA, passageB],
        embedding_model: "bge-small",
        latency_ms: 42,
      },
      isPending: false,
      isError: false,
      error: null,
    });
    render(
      withProviders(
        <PassagePicker
          query="what does the corpus say"
          selected={[]}
          onAdd={vi.fn()}
          onRemove={vi.fn()}
        />,
      ),
    );
    await waitFor(() => {
      expect(screen.getAllByTestId("passage-result")).toHaveLength(2);
    });
    expect(screen.getByText(/2 passages found/)).toBeInTheDocument();
  });

  it("renders 'no matching passages' when search returns empty array", async () => {
    mocks.useCorpusSearch.mockReturnValue({
      mutate: vi.fn(),
      data: { passages: [], embedding_model: "bge-small", latency_ms: 12 },
      isPending: false,
      isError: false,
      error: null,
    });
    render(
      withProviders(
        <PassagePicker
          query="what does the corpus say"
          selected={[]}
          onAdd={vi.fn()}
          onRemove={vi.fn()}
        />,
      ),
    );
    await waitFor(() => {
      expect(screen.getByText(/No matching passages/i)).toBeInTheDocument();
    });
  });

  it("calls onAdd when the add button is clicked on a result", async () => {
    mocks.useCorpusSearch.mockReturnValue({
      mutate: vi.fn(),
      data: {
        passages: [passageA],
        embedding_model: "bge-small",
        latency_ms: 10,
      },
      isPending: false,
      isError: false,
      error: null,
    });
    const onAdd = vi.fn();
    const user = userEvent.setup();
    render(
      withProviders(
        <PassagePicker
          query="what does the corpus say"
          selected={[]}
          onAdd={onAdd}
          onRemove={vi.fn()}
        />,
      ),
    );
    await waitFor(() => {
      expect(screen.getByLabelText(/add passage/i)).toBeInTheDocument();
    });
    await user.click(screen.getByLabelText(/add passage/i));
    expect(onAdd).toHaveBeenCalledTimes(1);
    expect(onAdd).toHaveBeenCalledWith(
      expect.objectContaining({ path: "intro.md", line_start: 1, line_end: 5 }),
    );
  });

  it("calls onRemove when the selected passage's button is clicked", async () => {
    mocks.useCorpusSearch.mockReturnValue({
      mutate: vi.fn(),
      data: {
        passages: [passageA],
        embedding_model: "bge-small",
        latency_ms: 10,
      },
      isPending: false,
      isError: false,
      error: null,
    });
    const onRemove = vi.fn();
    const user = userEvent.setup();
    render(
      withProviders(
        <PassagePicker
          query="what does the corpus say"
          selected={[{ path: "intro.md", line_start: 1, line_end: 5 }]}
          onAdd={vi.fn()}
          onRemove={onRemove}
        />,
      ),
    );
    await waitFor(() => {
      expect(screen.getByLabelText(/remove passage/i)).toBeInTheDocument();
    });
    await user.click(screen.getByLabelText(/remove passage/i));
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it("expand/collapse chevron toggles the line-clamp-2 class on the content", async () => {
    mocks.useCorpusSearch.mockReturnValue({
      mutate: vi.fn(),
      data: {
        passages: [passageA],
        embedding_model: "bge-small",
        latency_ms: 10,
      },
      isPending: false,
      isError: false,
      error: null,
    });
    const user = userEvent.setup();
    render(
      withProviders(
        <PassagePicker
          query="what does the corpus say"
          selected={[]}
          onAdd={vi.fn()}
          onRemove={vi.fn()}
        />,
      ),
    );
    await waitFor(() => {
      expect(screen.getByLabelText(/expand passage/i)).toBeInTheDocument();
    });
    // Initially collapsed — find a paragraph containing the passage text with line-clamp-2
    const content = screen.getByText((c) => c.includes("long passage explaining"));
    expect(content.className).toMatch(/line-clamp-2/);
    await user.click(screen.getByLabelText(/expand passage/i));
    // After expand, line-clamp-2 should be gone
    await waitFor(() => {
      expect(content.className).not.toMatch(/line-clamp-2/);
    });
    // And the collapse chevron is available
    expect(screen.getByLabelText(/collapse passage/i)).toBeInTheDocument();
  });

  it("renders the error UI when search.isError is true", () => {
    mocks.useCorpusSearch.mockReturnValue({
      mutate: vi.fn(),
      data: null,
      isPending: false,
      isError: true,
      error: { message: "search blew up" },
    });
    render(
      withProviders(
        <PassagePicker
          query="what does the corpus say"
          selected={[]}
          onAdd={vi.fn()}
          onRemove={vi.fn()}
        />,
      ),
    );
    expect(screen.getByText(/Search failed: search blew up/i)).toBeInTheDocument();
  });

  it("debounces the search call by 350ms", async () => {
    const searchMutate = vi.fn();
    mocks.useCorpusSearch.mockReturnValue({
      mutate: searchMutate,
      data: null,
      isPending: false,
      isError: false,
      error: null,
    });
    const { rerender } = render(
      withProviders(
        <PassagePicker
          query="ho"
          selected={[]}
          onAdd={vi.fn()}
          onRemove={vi.fn()}
        />,
      ),
    );
    rerender(
      withProviders(
        <PassagePicker
          query="how does ranking work"
          selected={[]}
          onAdd={vi.fn()}
          onRemove={vi.fn()}
        />,
      ),
    );
    // Before debounce elapses
    expect(searchMutate).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 400));
    expect(searchMutate).toHaveBeenCalled();
    const [args] = searchMutate.mock.calls[0];
    expect(args).toMatchObject({ query: "how does ranking work", k: 10 });
  });
});
