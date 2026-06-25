const MAX_BODY_BYTES = 4 * 1024 * 1024;

const createEmptySessionFoldersState = () => ({
  version: 1,
  rev: 0,
  foldersMap: {},
  collapsedFolderIds: [],
  updatedAt: 0,
});

const normalizeSessionFoldersState = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return createEmptySessionFoldersState();
  }

  const state = value;
  return {
    ...state,
    version: typeof state.version === 'number' ? state.version : 1,
    rev: Number.isSafeInteger(state.rev) && state.rev >= 0 ? state.rev : 0,
    foldersMap: state.foldersMap && typeof state.foldersMap === 'object' && !Array.isArray(state.foldersMap)
      ? state.foldersMap
      : {},
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

  const readCurrentState = async () => {
    const raw = await fsPromises.readFile(filePath, 'utf8').catch((error) => {
      if (error && error.code === 'ENOENT') return null;
      throw error;
    });

    if (!raw) {
      return createEmptySessionFoldersState();
    }

    try {
      return normalizeSessionFoldersState(JSON.parse(raw));
    } catch {
      return createEmptySessionFoldersState();
    }
  };

  app.get('/api/session-folders', async (_req, res) => {
    try {
      return res.json(await readCurrentState());
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to read session folders';
      return res.status(500).json({ error: message });
    }
  });

  app.post('/api/session-folders', async (req, res) => {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return res.status(400).json({ error: 'Body must be an object' });
    }
    const bodySize = Buffer.byteLength(JSON.stringify(body), 'utf8');
    if (bodySize > MAX_BODY_BYTES) {
      return res.status(413).json({ error: 'Payload too large' });
    }

    const save = async () => {
      const currentState = await readCurrentState();
      if (!Number.isSafeInteger(body.baseRev) || body.baseRev !== currentState.rev) {
        return res.status(409).json({
          error: 'Session folders changed on the server',
          currentRev: currentState.rev,
          currentState,
        });
      }

      const nextState = normalizeSessionFoldersState({
        ...body,
        rev: currentState.rev + 1,
      });
      delete nextState.baseRev;

      const serialized = JSON.stringify(nextState, null, 2);
      if (Buffer.byteLength(serialized, 'utf8') > MAX_BODY_BYTES) {
        return res.status(413).json({ error: 'Payload too large' });
      }

      let tmp;
      let saved = false;
      await ensureDir();
      tmp = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      try {
        await fsPromises.writeFile(tmp, serialized, 'utf8');
        await fsPromises.rename(tmp, filePath);
        saved = true;
        return res.json({ success: true, rev: nextState.rev });
      } catch (error) {
        if (tmp && !saved) {
          await fsPromises.unlink(tmp).catch(() => {});
        }
        throw error;
      }
    };

    const savePromise = writeQueue.then(save, save);
    writeQueue = savePromise.catch(() => {});

    try {
      return await savePromise;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to write session folders';
      return res.status(500).json({ error: message });
    }
  });
};
