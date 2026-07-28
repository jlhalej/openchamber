import { create } from 'zustand';
import { persist } from 'zustand/middleware';

type SessionDisplayMode = 'default' | 'minimal';

type ProjectSortOrder = 'manual' | 'a-z' | 'z-a' | 'date-added' | 'recent';

// +hj: folder sort — no 'manual' (drag is broken) and no 'recent' (no per-folder usage signal)
type FolderSortOrder = 'a-z' | 'z-a' | 'date-added';

type SessionDisplayStore = {
  displayMode: SessionDisplayMode;
  showRecentSection: boolean;
  showArchivedSessions: boolean;
  projectSortOrder: ProjectSortOrder;
  folderSortOrder: FolderSortOrder;
  setDisplayMode: (mode: SessionDisplayMode) => void;
  setShowRecentSection: (show: boolean) => void;
  setShowArchivedSessions: (show: boolean) => void;
  toggleRecentSection: () => void;
  toggleArchivedSessions: () => void;
  setProjectSortOrder: (order: ProjectSortOrder) => void;
  setFolderSortOrder: (order: FolderSortOrder) => void;
};

export const migrateSessionDisplayState = (
  persisted: unknown,
  version: number,
): Partial<SessionDisplayStore> => {
  const state = (persisted ?? {}) as Partial<SessionDisplayStore>;
  if (version < 1) {
    return { ...state, displayMode: 'minimal', projectSortOrder: 'manual' };
  }
  if (version < 2) {
    return { ...state, projectSortOrder: 'manual' };
  }
  if (version < 3 && state.projectSortOrder === 'recent') {
    return { ...state, projectSortOrder: 'manual' };
  }
  // v3→v4: folderSortOrder added; default 'a-z' comes from store initializer
  return state;
};

export const useSessionDisplayStore = create<SessionDisplayStore>()(
  persist(
    (set) => ({
      displayMode: 'minimal',
      showRecentSection: true,
      // Default to HIDDEN so the pre-hydration state matches the quiet/safe
      // option: archived sessions must never flash visible on startup and then
      // disappear once the persisted preference rehydrates. Users who opted into
      // showing archived have `true` persisted, which is preserved on rehydrate.
      showArchivedSessions: false,
      projectSortOrder: 'manual',
      folderSortOrder: 'a-z',
      setDisplayMode: (mode) => set({ displayMode: mode }),
      setShowRecentSection: (show) => set({ showRecentSection: show }),
      setShowArchivedSessions: (show) => set({ showArchivedSessions: show }),
      toggleRecentSection: () => set((state) => ({ showRecentSection: !state.showRecentSection })),
      toggleArchivedSessions: () => set((state) => ({ showArchivedSessions: !state.showArchivedSessions })),
      setProjectSortOrder: (order) => set({ projectSortOrder: order }),
      setFolderSortOrder: (order) => set({ folderSortOrder: order }),
    }),
    {
      name: 'session-display-mode',
      version: 4,
      // v0 shipped 'default' as the only/initial mode, so most existing users
      // have it persisted by accident rather than choice. Nudge everyone onto
      // minimal once so the mode can be evaluated before removing it entirely.
      // v1→v2 adds projectSortOrder using the canonical manual ordering.
      // v2→v3 replaces the previously shipped recent default with manual.
      // v3→v4 (+hj) adds folderSortOrder defaulting to 'a-z'.
      migrate: migrateSessionDisplayState,
    },
  ),
);

export type { ProjectSortOrder, FolderSortOrder };
