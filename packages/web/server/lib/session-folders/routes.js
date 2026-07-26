const MAX_BODY_BYTES = 4 * 1024 * 1024;

const isObjectRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const hasValidFolderShape = (folder) => (
  isObjectRecord(folder)
  && typeof folder.id === 'string'
  && typeof folder.name === 'string'
  && Array.isArray(folder.sessionIds)
  && folder.sessionIds.every((sessionId) => typeof sessionId === 'string')
  && typeof folder.createdAt === 'number'
  && Number.isFinite(folder.createdAt)
  && (folder.parentId === undefined || folder.parentId === null || typeof folder.parentId === 'string')
);

const hasValidFoldersMapShape = (foldersMap) => (
  isObjectRecord(foldersMap)
  && Object.values(foldersMap).every((folders) => (
    Array.isArray(folders) && folders.every(hasValidFolderShape)
  ))
);

const hasValidFolderSnapshotShape = (snapshot) => (
  isObjectRecord(snapshot)
  && snapshot.version === 1
  && hasValidFoldersMapShape(snapshot.foldersMap)
  && Array.isArray(snapshot.collapsedFolderIds)
  && snapshot.collapsedFolderIds.every((folderId) => typeof folderId === 'string')
);

const hasValidUpdatedAt = (value) => typeof value === 'number' && Number.isFinite(value) && value > 0;

const createEmptySessionFoldersState = () => ({
  version: 1,
  rev: 0,
  foldersMap: {},
  collapsedFolderIds: [],
  updatedAt: 0,
});

const normalizeSessionFoldersState = (value) => {
  if (!isObjectRecord(value)) {
    return createEmptySessionFoldersState();
  }

  const state = value;
  return {
    ...state,
    version: typeof state.version === 'number' ? state.version : 1,
    rev: Number.isSafeInteger(state.rev) && state.rev >= 0 ? state.rev : 0,
    foldersMap: hasValidFoldersMapShape(state.foldersMap) ? state.foldersMap : {},
    collapsedFolderIds: Array.isArray(state.collapsedFolderIds) ? state.collapsedFolderIds : [],
    updatedAt: typeof state.updatedAt === 'number' ? state.updatedAt : 0,
  };
};

export const registerSessionFoldersRoutes = (app, dependencies) => {
  const {
    fsPromises,
    path,
    openchamberDataDir,
  } = dependencies;

  const filePath = path.join(openchamberDataDir, 'sessions-directories.json');
  let writeQueue = Promise.resolve();

  const ensureDir = async () => {
    await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
  };

  /**
   * Reports missing, malformed, and valid stored state separately. GET refuses
   * to present malformed state as authoritative; POST treats it as carrying no
   * trustworthy revision so a valid snapshot can repair it. Read failures throw.
   */
  const readCurrentState = async () => {
    const raw = await fsPromises.readFile(filePath, 'utf8').catch((error) => {
      if (error && error.code === 'ENOENT') return null;
      throw error;
    });

    if (!raw) {
      return { state: createEmptySessionFoldersState(), exists: false, malformed: null };
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { state: createEmptySessionFoldersState(), exists: true, malformed: 'unparseable' };
    }

    if (!hasValidFolderSnapshotShape(parsed) || !hasValidUpdatedAt(parsed.updatedAt)) {
      return { state: createEmptySessionFoldersState(), exists: true, malformed: 'shape' };
    }

    return { state: normalizeSessionFoldersState(parsed), exists: true, malformed: null };
  };

  app.get('/api/session-folders', async (_req, res) => {
    try {
      const current = await readCurrentState();

      if (!current.exists) {
        return res.json({ ...createEmptySessionFoldersState(), exists: false });
      }

      if (current.malformed === 'unparseable') {
        return res.status(500).json({ error: 'Stored session folders are malformed' });
      }

      if (current.malformed) {
        return res.status(500).json({ error: 'Stored session folders have an invalid shape' });
      }

      return res.json({ ...current.state, exists: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to read session folders';
      return res.status(500).json({ error: message });
    }
  });

  app.post('/api/session-folders', async (req, res) => {
    const body = req.body;
    if (!isObjectRecord(body)) {
      return res.status(400).json({ error: 'Body must be an object' });
    }
    if (Buffer.byteLength(JSON.stringify(body), 'utf8') > MAX_BODY_BYTES) {
      return res.status(413).json({ error: 'Payload too large' });
    }
    if (!hasValidFolderSnapshotShape(body)) {
      return res.status(400).json({ error: 'Invalid session folders payload' });
    }
    if (!hasValidUpdatedAt(body.updatedAt)) {
      return res.status(400).json({ error: 'updatedAt must be a positive finite number' });
    }

    const save = async () => {
      const current = await readCurrentState();
      const baseRevMatches = Number.isSafeInteger(body.baseRev) && body.baseRev === current.state.rev;

      // Malformed stored state carries no trustworthy revision, so a valid
      // snapshot repairs it instead of deadlocking on a revision mismatch.
      if (!current.malformed && !baseRevMatches) {
        return res.status(409).json({
          error: 'Session folders changed on the server',
          currentRev: current.state.rev,
          currentState: { ...current.state, exists: current.exists },
        });
      }

      const nextState = normalizeSessionFoldersState({
        ...body,
        rev: current.state.rev + 1,
      });
      delete nextState.baseRev;
      delete nextState.exists;

      const serialized = JSON.stringify(nextState, null, 2);
      if (Buffer.byteLength(serialized, 'utf8') > MAX_BODY_BYTES) {
        return res.status(413).json({ error: 'Payload too large' });
      }

      await ensureDir();
      const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      let saved = false;
      try {
        await fsPromises.writeFile(tmp, serialized, 'utf8');
        await fsPromises.rename(tmp, filePath);
        saved = true;
        return res.json({ success: true, rev: nextState.rev });
      } catch (error) {
        if (!saved) {
          await fsPromises.unlink(tmp).catch(() => {});
        }
        throw error;
      }
    };

    const savePromise = writeQueue.then(save, save);
    writeQueue = savePromise.then(() => undefined, () => undefined);

    try {
      return await savePromise;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to write session folders';
      return res.status(500).json({ error: message });
    }
  });
};
