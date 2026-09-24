/**
 * When a project card's face may open the project.
 *
 * The face opens the project on click, Enter, long-press and context menu.
 * Its options menu and the Project info dialog live inside the card, and
 * the interaction that ends them lands on the face: the press that
 * dismisses the menu hits the card the instant the menu lifts its pointer
 * block, and the click that follows that press would open the project. A
 * click inside the portaled dialog still bubbles through the React tree.
 * None of those is a request to open the project.
 *
 * Two guards, because they fail differently: the press that dismissed the
 * menu marks the click it produces (`dismissingClick`), which holds however
 * long the browser takes between the two; and a short settle after a menu
 * or dialog closes swallows a double-click's second click. Then the face
 * is back to normal.
 */
export const FACE_SETTLE_MS = 400;

export function faceOpensProject(state: {
  readonly menuOpen: boolean;
  readonly dialogOpen: boolean;
  /** The click being judged came from the press that dismissed the menu. */
  readonly dismissingClick: boolean;
  /** When the menu or dialog last closed, or null if never. */
  readonly closedAt: number | null;
  readonly now: number;
}): boolean {
  if (state.menuOpen || state.dialogOpen || state.dismissingClick) return false;
  if (state.closedAt !== null && state.now - state.closedAt < FACE_SETTLE_MS) return false;
  return true;
}
