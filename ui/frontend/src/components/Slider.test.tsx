import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { Slider } from "./Slider";
import {
  assertNoHorizontalOverflow,
  drag,
  sliderPct,
} from "@/test/actuation-helpers";

function ControlledSlider(
  props: Omit<React.ComponentProps<typeof Slider>, "value" | "onChange"> & {
    initial?: number;
    onChange?: (v: number) => void;
  },
) {
  const { initial = 0, onChange, ...rest } = props;
  const [v, setV] = useState<number>(initial);
  return (
    <Slider
      {...rest}
      value={v}
      onChange={(next) => {
        setV(next);
        onChange?.(next);
      }}
    />
  );
}

describe("Slider", () => {
  it("renders the label, current value, and bounds", () => {
    render(
      <Slider label="Volume" value={30} min={0} max={100} step={5} onChange={() => {}} />,
    );
    expect(screen.getByText("Volume")).toBeInTheDocument();
    expect(screen.getByText("30")).toBeInTheDocument();
    const input = screen.getByLabelText("Volume") as HTMLInputElement;
    expect(input).toHaveAttribute("min", "0");
    expect(input).toHaveAttribute("max", "100");
    expect(input).toHaveAttribute("step", "5");
    expect(input.type).toBe("range");
  });

  it("uses format() to render the displayed value", () => {
    render(
      <Slider
        label="Ratio"
        value={0.42}
        min={0}
        max={1}
        step={0.01}
        onChange={() => {}}
        format={(v) => `${(v * 100).toFixed(0)}%`}
      />,
    );
    expect(screen.getByText("42%")).toBeInTheDocument();
  });

  it("renders the optional hint copy", () => {
    render(
      <Slider
        label="Temp"
        value={0.5}
        min={0}
        max={1}
        onChange={() => {}}
        hint="Higher is more random."
      />,
    );
    expect(screen.getByText(/Higher is more random/i)).toBeInTheDocument();
  });

  it("exposes a deterministic data-testid based on the label slug", () => {
    render(
      <Slider label="Recall @ 5" value={0} min={0} max={1} onChange={() => {}} />,
    );
    const input = screen.getByTestId("slider-recall-5");
    expect(input.tagName).toBe("INPUT");
  });

  it("fires onChange with a numeric value when dragged", () => {
    const onChange = vi.fn();
    render(
      <Slider label="X" value={5} min={0} max={10} step={1} onChange={onChange} />,
    );
    drag(screen.getByLabelText("X"), 8);
    expect(onChange).toHaveBeenCalledWith(8);
    expect(typeof onChange.mock.calls[0][0]).toBe("number");
  });

  it("keyboard actuation (arrow keys) simulates step increments and decrements", () => {
    // jsdom does not actually implement the native range-input keyboard
    // handler (it fires keydown but never changes the value or emits a
    // change event). We model the contract — ArrowRight should advance the
    // value by `step` — by firing change events at the expected new values
    // and asserting onChange receives them. The keyboard binding itself is
    // covered by Playwright e2e + real browsers.
    const onChange = vi.fn();
    render(
      <ControlledSlider
        label="K"
        min={0}
        max={20}
        step={2}
        initial={10}
        onChange={onChange}
      />,
    );
    const input = screen.getByLabelText("K");
    drag(input, 12); // simulate ArrowRight
    expect(onChange).toHaveBeenLastCalledWith(12);
    drag(input, 8); // simulate two ArrowLefts from 12
    expect(onChange).toHaveBeenLastCalledWith(8);
  });

  it("clamps at min when dragged below the range", () => {
    const onChange = vi.fn();
    render(
      <Slider label="Y" value={5} min={0} max={10} onChange={onChange} />,
    );
    drag(screen.getByLabelText("Y"), -100);
    // The native input clamps the *DOM* value to "0"; onChange receives the
    // clamped number.
    expect(onChange).toHaveBeenLastCalledWith(0);
  });

  it("clamps at max when dragged above the range", () => {
    const onChange = vi.fn();
    render(
      <Slider label="Z" value={5} min={0} max={10} onChange={onChange} />,
    );
    drag(screen.getByLabelText("Z"), 9999);
    expect(onChange).toHaveBeenLastCalledWith(10);
  });

  it("writes the correct fill percentage to data-percentage", () => {
    render(<Slider label="P" value={25} min={0} max={100} onChange={() => {}} />);
    const input = screen.getByTestId("slider-p");
    expect(sliderPct(input)).toBeCloseTo(25, 2);
  });

  it("computes percentage correctly for fractional ranges", () => {
    render(<Slider label="Q" value={0.4} min={0} max={1} step={0.05} onChange={() => {}} />);
    expect(sliderPct(screen.getByTestId("slider-q"))).toBeCloseTo(40, 1);
  });

  it("forwards extra props (like aria-describedby) to the input", () => {
    render(
      <Slider
        label="A"
        value={0}
        min={0}
        max={10}
        onChange={() => {}}
        aria-describedby="helper-id"
      />,
    );
    const input = screen.getByLabelText("A");
    expect(input).toHaveAttribute("aria-describedby", "helper-id");
  });

  it("uses step=1 by default", () => {
    render(<Slider label="Default Step" value={0} min={0} max={10} onChange={() => {}} />);
    expect(screen.getByLabelText("Default Step")).toHaveAttribute("step", "1");
  });

  // ---- Overflow regression for the user-reported bug ----

  it("regression: wrapper renders w-full + min-w-0 so it does not overflow", () => {
    const { container } = render(
      <div style={{ width: "400px" }}>
        <Slider
          label="Very long label that could try to push the row wider than its container"
          value={0.42}
          min={0}
          max={1}
          step={0.01}
          onChange={() => {}}
          format={(v) => `${(v * 100).toFixed(1)}%`}
        />
      </div>,
    );
    const wrapper = container.querySelector(
      "[data-testid$='-wrapper']",
    ) as HTMLElement;
    expect(wrapper).toBeTruthy();
    expect(wrapper.className).toMatch(/w-full/);
    expect(wrapper.className).toMatch(/min-w-0/);
    assertNoHorizontalOverflow(wrapper);
  });

  it("regression: input has w-full + max-w-full + box-border so padding does not bust the box", () => {
    render(
      <Slider label="check" value={0} min={0} max={1} step={0.1} onChange={() => {}} />,
    );
    const input = screen.getByLabelText("check");
    expect(input.className).toMatch(/w-full/);
    expect(input.className).toMatch(/max-w-full/);
    expect(input.className).toMatch(/box-border/);
  });

  it("regression: slug stays alphanumeric for labels with punctuation/whitespace", () => {
    render(
      <Slider
        label="Recall @ 5 — composite!"
        value={0}
        min={0}
        max={1}
        onChange={() => {}}
      />,
    );
    // Punctuation is collapsed to single dashes.
    expect(screen.getByTestId("slider-recall-5-composite")).toBeInTheDocument();
  });
});
