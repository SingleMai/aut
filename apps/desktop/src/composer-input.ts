// Draft acknowledgement adapted from OpenMausBot src/lib/drafts.ts,
// commit 738ec88472a3b888ff7b7793755d89da613ed301, Apache-2.0. See NOTICE.

/** Clear only the acknowledged snapshot; typing while the request is in flight remains a draft. */
export const clearSubmittedDraft = (
  input: { value: string; readonly dispatchEvent: (event: Event) => boolean },
  submittedText: string,
): boolean => {
  if (input.value !== submittedText) return false;
  input.value = "";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  return true;
};
