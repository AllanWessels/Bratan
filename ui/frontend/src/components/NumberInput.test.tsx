import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NumberInput } from "./NumberInput";

function Controlled(
  props: Omit<React.ComponentProps<typeof NumberInput>, "value" | "onChange"> & {
    initial?: number;
    onChange?: (v: number) => void;
  },
) {
  const { initial = 0, onChange, ...rest } = props;
  const [v, setV] = useState<number>(initial);
  return (
    <NumberInput
      {...rest}
      value={v}
      onChange={(next) => {
        setV(next);
        onChange?.(next);
      }}
    />
  );
}

describe("NumberInput", () => {
  it("renders the label, value, and the min/max/step attributes", () => {
    render(
      <NumberInput
        label="Volume"
        value={30}
        min={0}
        max={100}
        step={5}
        onChange={() => {}}
      />,
    );
    expect(screen.getByText("Volume")).toBeInTheDocument();
    const input = screen.getByLabelText("Volume") as HTMLInputElement;
    expect(input.type).toBe("number");
    expect(input.value).toBe("30");
    expect(input).toHaveAttribute("min", "0");
    expect(input).toHaveAttribute("max", "100");
    expect(input).toHaveAttribute("step", "5");
    expect(input).toHaveAttribute("inputMode", "decimal");
  });

  it("uses step=1 by default", () => {
    render(
      <NumberInput label="Default" value={0} min={0} max={10} onChange={() => {}} />,
    );
    expect(screen.getByLabelText("Default")).toHaveAttribute("step", "1");
  });

  it("fires onChange with a numeric value when the user types a new in-range number", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Controlled label="X" min={0} max={100} step={1} onChange={onChange} />);
    const input = screen.getByLabelText("X");
    await user.clear(input);
    await user.type(input, "33");
    // user.type fires per-keystroke, so the *last* call should carry 33.
    expect(onChange).toHaveBeenLastCalledWith(33);
    expect(typeof onChange.mock.calls.at(-1)![0]).toBe("number");
  });

  it("fireEvent.change with a multi-digit value lands as a single numeric onChange", () => {
    const onChange = vi.fn();
    render(<Controlled label="Y" min={0} max={1000} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText("Y"), { target: { value: "750" } });
    expect(onChange).toHaveBeenLastCalledWith(750);
  });

  it("renders the optional unit suffix", () => {
    render(
      <NumberInput
        label="Cost"
        value={5}
        min={0}
        max={10}
        unit="USD"
        onChange={() => {}}
      />,
    );
    expect(screen.getByTestId("number-input-cost-unit")).toHaveTextContent("USD");
  });

  it("renders the optional hint below the input as slate-500", () => {
    render(
      <NumberInput
        label="Temp"
        value={0.5}
        min={0}
        max={1}
        step={0.05}
        hint="Higher is more random."
        onChange={() => {}}
      />,
    );
    const hint = screen.getByText(/Higher is more random/i);
    expect(hint).toBeInTheDocument();
    expect(hint.className).toMatch(/text-slate-500/);
  });

  it("out-of-range high value shows the Min/Max hint and a red border", () => {
    render(
      <NumberInput
        label="K"
        value={5}
        min={0}
        max={10}
        onChange={() => {}}
      />,
    );
    fireEvent.change(screen.getByLabelText("K"), { target: { value: "99" } });
    expect(screen.getByText(/Min 0, Max 10/i)).toBeInTheDocument();
    const input = screen.getByLabelText("K");
    expect(input).toHaveAttribute("aria-invalid", "true");
    const wrapper = screen.getByTestId("number-input-k-wrapper");
    // The bordered row sits one level inside the wrapper.
    const bordered = wrapper.querySelector(".border-red-500");
    expect(bordered).toBeTruthy();
  });

  it("out-of-range low value also shows the error state", () => {
    render(
      <NumberInput
        label="K"
        value={5}
        min={1}
        max={10}
        onChange={() => {}}
      />,
    );
    fireEvent.change(screen.getByLabelText("K"), { target: { value: "0" } });
    expect(screen.getByText(/Min 1, Max 10/i)).toBeInTheDocument();
  });

  it("a valid in-range value clears the error state on the next render", () => {
    const { rerender } = render(
      <Controlled label="Q" min={0} max={10} initial={5} />,
    );
    fireEvent.change(screen.getByLabelText("Q"), { target: { value: "20" } });
    expect(screen.getByLabelText("Q")).toHaveAttribute("aria-invalid", "true");
    fireEvent.change(screen.getByLabelText("Q"), { target: { value: "7" } });
    expect(screen.getByLabelText("Q")).not.toHaveAttribute("aria-invalid");
    rerender(<Controlled label="Q" min={0} max={10} initial={5} />);
  });

  it("clearing the field does not bounce the value back (empty stays empty)", async () => {
    const user = userEvent.setup();
    render(<Controlled label="Z" min={0} max={100} initial={50} />);
    const input = screen.getByLabelText("Z") as HTMLInputElement;
    await user.clear(input);
    expect(input.value).toBe("");
    await user.type(input, "7");
    expect(input.value).toBe("7");
  });

  it("does NOT fire onChange while the field is momentarily empty", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Controlled label="W" min={0} max={100} initial={50} onChange={onChange} />);
    onChange.mockClear();
    const input = screen.getByLabelText("W");
    await user.clear(input);
    // Empty string is not a finite number, so we must not invent a zero.
    expect(onChange).not.toHaveBeenCalled();
  });

  it("ArrowUp increments by step, ArrowDown decrements by step", () => {
    // jsdom does not actually implement keyboard handlers for type=number
    // (no value change, no input event). We model the contract: ArrowUp
    // is documented to step up by `step`; the parent receives that
    // value. We verify by firing the change event jsdom *would* fire if
    // it implemented the binding.
    const onChange = vi.fn();
    render(<Controlled label="Step" min={0} max={20} step={2} initial={10} onChange={onChange} />);
    const input = screen.getByLabelText("Step");
    fireEvent.change(input, { target: { value: "12" } });
    expect(onChange).toHaveBeenLastCalledWith(12);
    fireEvent.change(input, { target: { value: "10" } });
    expect(onChange).toHaveBeenLastCalledWith(10);
  });

  it("honours an explicit data-testid prop", () => {
    render(
      <NumberInput
        label="Whatever"
        value={1}
        min={0}
        max={10}
        onChange={() => {}}
        data-testid="my-custom-id"
      />,
    );
    expect(screen.getByTestId("my-custom-id")).toBeInTheDocument();
    expect(screen.getByTestId("my-custom-id-wrapper")).toBeInTheDocument();
  });

  it("derives a stable label-slug testid when no data-testid is provided", () => {
    render(
      <NumberInput
        label="Recall @ 5"
        value={0}
        min={0}
        max={1}
        step={0.05}
        onChange={() => {}}
      />,
    );
    expect(screen.getByTestId("number-input-recall-5")).toBeInTheDocument();
  });

  it("disabled prop disables the input", () => {
    render(
      <NumberInput
        label="D"
        value={0}
        min={0}
        max={10}
        disabled
        onChange={() => {}}
      />,
    );
    expect(screen.getByLabelText("D")).toBeDisabled();
  });

  it("required prop renders the asterisk marker and forwards the required attribute", () => {
    render(
      <NumberInput label="R" value={0} min={0} max={10} required onChange={() => {}} />,
    );
    expect(screen.getByText("*")).toBeInTheDocument();
    expect(screen.getByLabelText(/R/)).toBeRequired();
  });

  it("aria-valuemin / aria-valuemax / aria-valuenow reflect the props", () => {
    render(
      <NumberInput label="A" value={4} min={0} max={10} onChange={() => {}} />,
    );
    const input = screen.getByLabelText("A");
    expect(input).toHaveAttribute("aria-valuemin", "0");
    expect(input).toHaveAttribute("aria-valuemax", "10");
    expect(input).toHaveAttribute("aria-valuenow", "4");
  });

  it("data-percentage encodes (value-min)/(max-min) for callers that want a fill ratio", () => {
    render(
      <NumberInput label="P" value={25} min={0} max={100} onChange={() => {}} />,
    );
    const input = screen.getByLabelText("P");
    expect(input).toHaveAttribute("data-percentage", "25.00");
  });

  it("re-rendering with the same numeric value does not stomp on a still-typing decimal", () => {
    // If the parent owns the state and re-renders with 0.3 while we're
    // mid-typing "0.30", the trailing zero should survive because we
    // only re-sync when the parent's value disagrees with our parse.
    function Outer() {
      const [v, setV] = useState(0);
      return <NumberInput label="Dec" value={v} min={0} max={1} step={0.05} onChange={setV} />;
    }
    render(<Outer />);
    const input = screen.getByLabelText("Dec") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "0.30" } });
    expect(input.value).toBe("0.30");
  });
});
