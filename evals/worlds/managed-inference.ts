import { managedInference } from "@openwork/env";
import type { Place } from "@openwork/env";

/** The real managed-inference gateway in front of a scripted provider witness. */
export async function bootManagedInference(place: Place, options: { env?: Record<string, string> } = {}) {
  return managedInference(place, options);
}
