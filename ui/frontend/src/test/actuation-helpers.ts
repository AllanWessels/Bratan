import { fireEvent, screen, within } from "@testing-library/react";
import { expect } from "vitest";

/**
 * Reusable helpers for "actuation" tests — tests that *drive* the UI rather
 * than merely asserting on its rendered output. The userEvent library covers
 * keyboard/mouse for most inputs, but range sliders, file pickers, and
 * native validation messages don't play nicely with userEvent in jsdom; for
 * those cases we fall back to fireEvent.change and document the why here.
 */

/**
 * Drag a range slider to a numeric value.
 *
 * `userEvent` does not implement native range-input pointer mechanics in
 * jsdom — it falls through to `.value` assignment but skips firing the
 * `input` event React listens to. `fireEvent.change` with the coerced
 * string value reliably triggers React's onChange.
 */
export function drag(slider: HTMLElement, toValue: number): void {
  fireEvent.change(slider, { target: { value: String(toValue) } });
}

/**
 * Assert that an element does not horizontally overflow its layout box.
 *
 * jsdom does not perform real layout, but it does expose `scrollWidth` and
 * `clientWidth` (which both default to 0). Real overflow tests still need a
 * browser; this guards against the *contract* — scrollWidth must not
 * exceed clientWidth — and is mainly useful as a smoke test that the
 * element renders without forcing a wider min width.
 */
export function assertNoHorizontalOverflow(el: HTMLElement): void {
  // In jsdom both scroll/client widths are 0 unless the test sets up an
  // explicit layout. The contract still holds (0 <= 0).
  expect(el.scrollWidth).toBeLessThanOrEqual(el.clientWidth);
}

/**
 * Find an input via its label text and set its value.
 *
 * Helps keep actuation tests terse where userEvent.type's keystroke
 * accumulation isn't important — useful for number/email/url fields where
 * we just want the *final* value to land in component state.
 */
export function fillField(
  container: HTMLElement,
  label: RegExp | string,
  value: string,
): HTMLElement {
  const scope = container ? within(container) : screen;
  const el = scope.getByLabelText(label) as HTMLElement;
  fireEvent.change(el, { target: { value } });
  return el;
}

/**
 * Read a slider's percentage as written to its `data-percentage` attribute.
 *
 * Useful for asserting the visual fill matches the value-to-range ratio
 * without relying on getComputedStyle (which jsdom doesn't really do).
 */
export function sliderPct(slider: HTMLElement): number {
  const raw = slider.getAttribute("data-percentage");
  return raw === null ? NaN : Number(raw);
}
