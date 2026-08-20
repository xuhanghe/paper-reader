// Where you were before you followed something.
//
// The reader is full of jumps — a citation into the paper, an underlined
// passage into a conversation, a quote back to where it was said. Each one
// takes you somewhere useful and leaves you with no way back except finding
// your place again by hand. This is that way back, and forward again after it,
// the way a browser's two buttons work.

export type Spot = {
  // Scroll positions of the two panes, and which conversation was open
  doc: number;
  panel: number;
  activeId: string | null;
};

export type NavState = {
  back: Spot[];
  forward: Spot[];
};

export const emptyNav: NavState = { back: [], forward: [] };

// How far back it is worth being able to go. Older entries fall off the end —
// a reading session is long, and nobody navigates back forty jumps.
export const NAV_LIMIT = 30;

// Two spots are the same place if neither pane has really moved. Following a
// citation whose passage is already on screen should not add a step that does
// nothing when taken.
const SLACK_PX = 24;
export function samePlace(a: Spot, b: Spot): boolean {
  return (
    a.activeId === b.activeId &&
    Math.abs(a.doc - b.doc) < SLACK_PX &&
    Math.abs(a.panel - b.panel) < SLACK_PX
  );
}

// Taking a new jump discards the forward trail, exactly as a browser does:
// once you go somewhere else, what you had gone back from is no longer ahead.
export function record(state: NavState, from: Spot): NavState {
  const previous = state.back[state.back.length - 1];
  if (previous && samePlace(previous, from)) return state.forward.length ? { ...state, forward: [] } : state;
  return { back: [...state.back, from].slice(-NAV_LIMIT), forward: [] };
}

// Going back returns the spot to restore, and remembers where we left so
// forward can undo it.
export function back(state: NavState, here: Spot): { state: NavState; to: Spot } | null {
  if (state.back.length === 0) return null;
  const to = state.back[state.back.length - 1];
  return {
    state: { back: state.back.slice(0, -1), forward: [...state.forward, here].slice(-NAV_LIMIT) },
    to,
  };
}

export function forward(state: NavState, here: Spot): { state: NavState; to: Spot } | null {
  if (state.forward.length === 0) return null;
  const to = state.forward[state.forward.length - 1];
  return {
    state: { back: [...state.back, here].slice(-NAV_LIMIT), forward: state.forward.slice(0, -1) },
    to,
  };
}
