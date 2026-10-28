import { createContext } from "react";

export interface DocumentEditState {
  jobLocked: boolean;
  positioning: boolean;
  recovering: boolean;
  converting: boolean;
}

/** One policy boundary for document, source, font, layout and path mutations.
 * A future mid-job editor must explicitly change this policy and snapshot contract.
 */
export function documentEditPolicy(state: DocumentEditState) {
  return { canEditDocument: !Object.values(state).some(Boolean) };
}

export const DocumentEditLock = createContext(false);
