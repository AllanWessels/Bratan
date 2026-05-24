import { resetBratanState } from "./helpers";

/**
 * Wipe wizard + authoring state once before the suite runs.
 *
 * The same `resetBratanState()` is also called from each spec's `beforeEach`
 * so individual tests are independent. The global hook just ensures we
 * never inherit a stale `bratan.config.yaml` from a developer's prior session.
 */
export default async function globalSetup(): Promise<void> {
  resetBratanState();
}
