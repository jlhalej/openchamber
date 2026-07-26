import { describe, expect, it, vi } from 'vitest';
import path from 'path';

import { registerSessionFoldersRoutes } from './routes.js';

const createRouteRegistry = () => {
  const routes = new Map();

  return {
    app: {
      get(routePath, handler) {
        routes.set(`GET ${routePath}`, handler);
      },
      post(routePath, handler) {
        routes.set(`POST ${routePath}`, handler);
      },
    },
    getRoute(method, routePath) {
      return routes.get(`${method} ${routePath}`);
    },
  };
};

const createMockResponse = () => {
  let statusCode = 200;
  let body = null;

  return {
    status(code) {
      statusCode = code;
      return this;
    },
    json(payload) {
      body = payload;
      return this;
    },
    get statusCode() {
      return statusCode;
    },
    get body() {
      return body;
    },
  };
};

const folderPayload = (baseRev, updatedAt = 1, overrides = {}) => ({
  version: 1,
  baseRev,
  foldersMap: {},
  collapsedFolderIds: [],
  updatedAt,
  ...overrides,
});

describe('session folders routes', () => {
  const createFs = (initialRaw = null) => {
    let storedRaw = initialRaw;
    const tempFiles = new Map();

    return {
      fsPromises: {
        mkdir: vi.fn(async () => {}),
        readFile: vi.fn(async () => {
          if (storedRaw === null) {
            const error = new Error('not found');
            error.code = 'ENOENT';
            throw error;
          }
          return storedRaw;
        }),
        writeFile: vi.fn(async (tempPath, content) => {
          tempFiles.set(tempPath, content);
          await new Promise((resolve) => setTimeout(resolve, 0));
        }),
        rename: vi.fn(async (tempPath) => {
          storedRaw = tempFiles.get(tempPath);
        }),
        unlink: vi.fn(async () => {}),
      },
      getStoredRaw: () => storedRaw,
    };
  };

  const register = (fsPromises) => {
    const { app, getRoute } = createRouteRegistry();
    registerSessionFoldersRoutes(app, {
      fsPromises,
      path,
      openchamberDataDir: '/tmp/openchamber-test',
    });
    return getRoute;
  };

  it('reports a missing snapshot as revision zero without authoritative empty state', async () => {
    const { fsPromises } = createFs();
    const getRoute = register(fsPromises);
    const response = createMockResponse();

    await getRoute('GET', '/api/session-folders')({}, response);

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      version: 1,
      rev: 0,
      foldersMap: {},
      collapsedFolderIds: [],
      updatedAt: 0,
      exists: false,
    });
  });

  it('marks an existing snapshot as present', async () => {
    const stored = { version: 1, rev: 4, foldersMap: {}, collapsedFolderIds: [], updatedAt: 12 };
    const { fsPromises } = createFs(JSON.stringify(stored));
    const getRoute = register(fsPromises);
    const response = createMockResponse();

    await getRoute('GET', '/api/session-folders')({}, response);

    expect(response.body).toMatchObject({ ...stored, exists: true });
  });

  it('uses unique temp files for concurrent saves', async () => {
    const { fsPromises } = createFs();
    const handler = register(fsPromises)('POST', '/api/session-folders');

    await Promise.all([
      handler({ body: folderPayload(0, 1) }, createMockResponse()),
      handler({ body: folderPayload(1, 2) }, createMockResponse()),
    ]);

    const tempPaths = fsPromises.writeFile.mock.calls.map(([tempPath]) => tempPath);
    expect(tempPaths).toHaveLength(2);
    expect(new Set(tempPaths).size).toBe(2);
    expect(tempPaths.every((tempPath) => tempPath.includes('sessions-directories.json.tmp-'))).toBe(true);
  });

  it('removes the temp file when rename fails', async () => {
    const { fsPromises } = createFs();
    fsPromises.rename.mockImplementation(async () => {
      throw new Error('rename failed');
    });
    const handler = register(fsPromises)('POST', '/api/session-folders');
    const response = createMockResponse();

    await handler({ body: folderPayload(0) }, response);

    expect(response.statusCode).toBe(500);
    expect(fsPromises.unlink).toHaveBeenCalledWith(expect.stringContaining('sessions-directories.json.tmp-'));
  });

  it('rejects stale writes with the current server state', async () => {
    const currentState = { version: 1, rev: 3, foldersMap: { work: [] }, collapsedFolderIds: [], updatedAt: 10 };
    const { fsPromises } = createFs(JSON.stringify(currentState));
    const handler = register(fsPromises)('POST', '/api/session-folders');
    const response = createMockResponse();

    await handler({ body: folderPayload(2, 11) }, response);

    expect(response.statusCode).toBe(409);
    expect(response.body).toMatchObject({ currentRev: 3, currentState: { ...currentState, exists: true } });
    expect(fsPromises.writeFile).not.toHaveBeenCalled();
  });

  it('increments revision after matching writes and does not persist transport fields', async () => {
    const { fsPromises, getStoredRaw } = createFs();
    const handler = register(fsPromises)('POST', '/api/session-folders');
    const response = createMockResponse();

    await handler({ body: folderPayload(0, 11) }, response);

    expect(response.body).toMatchObject({ success: true, rev: 1 });
    const stored = JSON.parse(getStoredRaw());
    expect(stored).toMatchObject({ rev: 1, foldersMap: {}, collapsedFolderIds: [] });
    expect(stored).not.toHaveProperty('baseRev');
    expect(stored).not.toHaveProperty('exists');
  });

  it('keeps the stored snapshot when an out-of-order write arrives after a newer one', async () => {
    const { fsPromises, getStoredRaw } = createFs();
    const handler = register(fsPromises)('POST', '/api/session-folders');

    const first = createMockResponse();
    await handler({ body: folderPayload(0, 10, { foldersMap: { keep: [] } }) }, first);
    expect(first.body).toMatchObject({ success: true, rev: 1 });

    // A second client that never saw rev 1 must not clobber it.
    const stale = createMockResponse();
    await handler({ body: folderPayload(0, 20, { foldersMap: { clobber: [] } }) }, stale);

    expect(stale.statusCode).toBe(409);
    expect(JSON.parse(getStoredRaw())).toMatchObject({ rev: 1, foldersMap: { keep: [] } });
  });

  it('rejects a malformed stored snapshot instead of clearing valid browser state', async () => {
    const { fsPromises } = createFs('{broken');
    const getRoute = register(fsPromises);
    const response = createMockResponse();

    await getRoute('GET', '/api/session-folders')({}, response);

    expect(response.statusCode).toBe(500);
    expect(response.body).toEqual({ error: 'Stored session folders are malformed' });
  });

  it('rejects structurally invalid folder entries from disk', async () => {
    const malformedPayload = {
      version: 1,
      updatedAt: 10,
      collapsedFolderIds: [],
      foldersMap: { project: [{ id: 'folder', name: 'Folder', sessionIds: 'session-1', createdAt: 1 }] },
    };
    const { fsPromises } = createFs(JSON.stringify(malformedPayload));
    const getRoute = register(fsPromises);
    const response = createMockResponse();

    await getRoute('GET', '/api/session-folders')({}, response);

    expect(response.statusCode).toBe(500);
    expect(response.body).toEqual({ error: 'Stored session folders have an invalid shape' });
  });

  it('rejects a structurally invalid write payload', async () => {
    const { fsPromises } = createFs();
    const handler = register(fsPromises)('POST', '/api/session-folders');
    const response = createMockResponse();

    await handler({
      body: folderPayload(0, 1, {
        foldersMap: { project: [{ id: 'folder', name: 'Folder', sessionIds: 'session-1', createdAt: 1 }] },
      }),
    }, response);

    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({ error: 'Invalid session folders payload' });
    expect(fsPromises.writeFile).not.toHaveBeenCalled();
  });

  it('requires a positive finite updatedAt on writes', async () => {
    const { fsPromises } = createFs();
    const handler = register(fsPromises)('POST', '/api/session-folders');
    const response = createMockResponse();

    await handler({ body: folderPayload(0, 0) }, response);

    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({ error: 'updatedAt must be a positive finite number' });
    expect(fsPromises.writeFile).not.toHaveBeenCalled();
  });

  it('lets a valid snapshot repair structurally invalid prior state without a revision conflict', async () => {
    const { fsPromises, getStoredRaw } = createFs(
      JSON.stringify({ version: 1, updatedAt: 999, foldersMap: null, collapsedFolderIds: [] }),
    );
    const handler = register(fsPromises)('POST', '/api/session-folders');
    const response = createMockResponse();

    // The client's baseRev cannot match state that has no trustworthy revision;
    // the write must be accepted as a repair rather than answered with a 409
    // carrying a fabricated empty snapshot.
    await handler({ body: folderPayload(7, 1000, { foldersMap: { repaired: [] } }) }, response);

    expect(response.body).toMatchObject({ success: true, rev: 1 });
    expect(JSON.parse(getStoredRaw())).toMatchObject({ rev: 1, foldersMap: { repaired: [] } });
  });

  it('lets a valid snapshot repair unparseable prior state', async () => {
    const { fsPromises } = createFs('{broken');
    const handler = register(fsPromises)('POST', '/api/session-folders');
    const response = createMockResponse();

    await handler({ body: folderPayload(7, 1000) }, response);

    expect(response.body).toMatchObject({ success: true, rev: 1 });
    expect(fsPromises.writeFile).toHaveBeenCalledTimes(1);
  });

  it('rejects a non-object body', async () => {
    const { fsPromises } = createFs();
    const handler = register(fsPromises)('POST', '/api/session-folders');
    const response = createMockResponse();

    await handler({ body: [] }, response);

    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({ error: 'Body must be an object' });
  });

  it('surfaces read failures instead of reporting an empty snapshot', async () => {
    const fsPromises = {
      readFile: vi.fn(async () => {
        throw new Error('EACCES');
      }),
    };
    const getRoute = register(fsPromises);
    const response = createMockResponse();

    await getRoute('GET', '/api/session-folders')({}, response);

    expect(response.statusCode).toBe(500);
    expect(response.body).toEqual({ error: 'EACCES' });
  });
});
