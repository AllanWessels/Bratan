import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { Card } from "./Card";

describe("Card", () => {
  it("renders title + description + body", () => {
    render(
      <Card title="Step 1" description="Project basics">
        <p>Body content</p>
      </Card>,
    );
    expect(screen.getByRole("heading", { name: /step 1/i })).toBeInTheDocument();
    expect(screen.getByText("Project basics")).toBeInTheDocument();
    expect(screen.getByText("Body content")).toBeInTheDocument();
  });

  it("omits the header when no title or description", () => {
    render(
      <Card>
        <span data-testid="body">only body</span>
      </Card>,
    );
    expect(screen.queryByRole("heading")).not.toBeInTheDocument();
    expect(screen.getByTestId("body")).toBeInTheDocument();
  });

  it("renders footer when provided", () => {
    render(
      <Card title="t" footer={<button>Save</button>}>
        body
      </Card>,
    );
    expect(screen.getByRole("button", { name: /save/i })).toBeInTheDocument();
  });
});
