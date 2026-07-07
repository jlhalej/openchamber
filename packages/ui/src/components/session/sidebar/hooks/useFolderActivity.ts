import React from 'react';
import { useActiveSessionIdsAmong } from '@/sync/sync-context';
import { useAnySessionUnseen } from '@/sync/notification-store';

export type FolderActivitySummary = {
  activeCount: number;
  totalCount: number;
  anyBusy: boolean;
  anyUnseen: boolean;
};

/**
 * Derives a folder row's activity summary from three explicit id lists
 * (never from the whole sidebar's live state):
 * - `descendantNodeSubtreeIds`: one entry per session filed anywhere in the
 *   folder's subtree (including sessions in nested sub-folders), each
 *   containing that session's own id plus its subagent children — used for
 *   `activeCount`/`totalCount`. This must stay recursive like `descendantIds`
 *   below so a folder whose icon bubbles a nested sub-folder's activity
 *   doesn't show a count that ignores it.
 * - `descendantIds`: the full recursive set (including nested sub-folders)
 *   used to decide whether the folder icon should pulse.
 * - `unseenEligibleIds`: same as `descendantIds` but with subtask ids
 *   dropped unless the user opted into subtask notifications.
 */
export function useFolderActivity(
  descendantNodeSubtreeIds: readonly (readonly string[])[],
  descendantIds: readonly string[],
  unseenEligibleIds: readonly string[],
): FolderActivitySummary {
  const activeIds = useActiveSessionIdsAmong(descendantIds);
  const anyUnseenAmongDescendants = useAnySessionUnseen(unseenEligibleIds);

  return React.useMemo(() => {
    const anyBusy = activeIds.size > 0;
    const activeCount = descendantNodeSubtreeIds.reduce(
      (count, ids) => (ids.some((id) => activeIds.has(id)) ? count + 1 : count),
      0,
    );
    return {
      activeCount,
      totalCount: descendantNodeSubtreeIds.length,
      anyBusy,
      anyUnseen: !anyBusy && anyUnseenAmongDescendants,
    };
  }, [activeIds, anyUnseenAmongDescendants, descendantNodeSubtreeIds]);
}
