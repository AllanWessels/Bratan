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

/**
 * Drives every clickable control inside the PassagePicker:
 *   - expand chevron on each result
 *   - collapse chevron (after expanding)
 *   - add button on each result
 *   - remove button on each result (when already selected)
 *
 * The existing PassagePicker.test.tsx covers the single-passage happy
 * paths; this extends that to multi-passage interactions where one click
 * must not affect adjacent rows.
 */

function withProviders(ui: React.ReactNode) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

const passages: Passage[] = [
  {
    path: "intro.md",
    line_start: 1,
    line_end: 5,
    content: "Intro passage. ".repeat(10),
    score: 0.9,
  },
  {
    path: "guide.md",
    line_start: 10,
    line_end: 15,
    content: "Guide passage. ".repeat(10),
    score: 0.8,
  },
  {
    path: "spec.md",
    line_start: 20,
    line_end: 25,
    content: "Spec passage. ".repeat(10),
    score: 0.7,
  },
];

beforeEach(() => {
  mocks.useCorpusSearch.mockReturnValue({
    mutate: vi.fn(),
    data: { passages, embedding_model: "bge-small", latency_ms: 10 },
    isPending: false,
    isError: false,
    error: null,
  });
});

describe("PassagePicker actuation — every chevron + every add/remove", () => {
  it("clicking add on multiple passages fires onAdd for each one", async () => {
    const onAdd = vi.fn();
    const user = userEvent.setup();
    render(
      withProviders(
        <PassagePicker
          query="enough chars to trigger"
          selected={[]}
          onAdd={onAdd}
          onRemove={vi.fn()}
        />,
      ),
    );
    await waitFor(() => {
      expect(screen.getAllByLabelText(/add passage/i)).toHaveLength(3);
    });
    const adds = screen.getAllByLabelText(/add passage/i);
    await user.click(adds[0]);
    await user.click(adds[1]);
    await user.click(adds[2]);
    expect(onAdd).toHaveBeenCalledTimes(3);
    expect(onAdd.mock.calls[0][0].path).toBe("intro.md");
    expect(onAdd.mock.calls[1][0].path).toBe("guide.md");
    expect(onAdd.mock.calls[2][0].path).toBe("spec.md");
  });

  it("expanding one passage does not expand the others (single-expand invariant)", async () => {
    const user = userEvent.setup();
    render(
      withProviders(
        <PassagePicker
          query="enough chars to trigger"
          selected={[]}
          onAdd={vi.fn()}
          onRemove={vi.fn()}
        />,
      ),
    );
    await waitFor(() => {
      expect(screen.getAllByLabelText(/expand passage/i)).toHaveLength(3);
    });
    // Expand the first.
    const expanders = screen.getAllByLabelText(/expand passage/i);
    await user.click(expanders[0]);
    // After expand the other two should still be labelled "Expand passage".
    expect(screen.getAllByLabelText(/expand passage/i)).toHaveLength(2);
    expect(screen.getAllByLabelText(/collapse passage/i)).toHaveLength(1);
  });

  it("clicking an expanded passage's chevron collapses it", async () => {
    const user = userEvent.setup();
    render(
      withProviders(
        <PassagePicker
          query="enough chars to trigger"
          selected={[]}
          onAdd={vi.fn()}
          onRemove={vi.fn()}
        />,
      ),
    );
    await waitFor(() => {
      expect(screen.getAllByLabelText(/expand passage/i)).toHaveLength(3);
    });
    const expanders = screen.getAllByLabelText(/expand passage/i);
    await user.click(expanders[1]);
    expect(screen.getAllByLabelText(/collapse passage/i)).toHaveLength(1);
    await user.click(screen.getByLabelText(/collapse passage/i));
    expect(screen.queryByLabelText(/collapse passage/i)).not.toBeInTheDocument();
    expect(screen.getAllByLabelText(/expand passage/i)).toHaveLength(3);
  });

  it("clicking remove on a selected passage fires onRemove with the right ref", async () => {
    const onRemove = vi.fn();
    const user = userEvent.setup();
    render(
      withProviders(
        <PassagePicker
          query="enough chars to trigger"
          selected={[{ path: "guide.md", line_start: 10, line_end: 15 }]}
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
    expect(onRemove.mock.calls[0][0]).toMatchObject({
      path: "guide.md",
      line_start: 10,
      line_end: 15,
    });
  });

  it("rapid-fire click sequence fires every onAdd / onRemove without dropping events", async () => {
    const onAdd = vi.fn();
    const onRemove = vi.fn();
    const user = userEvent.setup();
    render(
      withProviders(
        <PassagePicker
          query="enough chars to trigger"
          selected={[{ path: "intro.md", line_start: 1, line_end: 5 }]}
          onAdd={onAdd}
          onRemove={onRemove}
        />,
      ),
    );
    await waitFor(() => {
      // One remove (intro is selected) + two adds (guide, spec)
      expect(screen.getByLabelText(/remove passage/i)).toBeInTheDocument();
    });
    const adds = screen.getAllByLabelText(/add passage/i);
    for (const b of adds) await user.click(b);
    await user.click(screen.getByLabelText(/remove passage/i));
    expect(onAdd).toHaveBeenCalledTimes(2);
    expect(onRemove).toHaveBeenCalledTimes(1);
  });
});
