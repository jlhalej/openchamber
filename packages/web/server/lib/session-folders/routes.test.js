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

  it('returns revision zero for missing state', async () => {
    const { app, getRoute } = createRouteRegistry();
    const { fsPromises } = createFs();

    registerSessionFoldersRoutes(app, {
      fsPromises,
      path,
      openchamberDataDir: '/tmp/openchamber-test',
    });

    const handler = getRoute('GET', '/api/session-folders');
    const response = createMockResponse();

    await handler({}, response);

    expect(response.body).toMatchObject({ rev: 0, foldersMap: {}, collapsedFolderIds: [] });
  });

  it('uses unique temp files for concurrent saves', async () => {
    const { app, getRoute } = createRouteRegistry();
    const { fsPromises } = createFs();

    registerSessionFoldersRoutes(app, {
      fsPromises,
      path,
      openchamberDataDir: '/tmp/openchamber-test',
    });

    const handler = getRoute('POST', '/api/session-folders');

    await Promise.all([
      handler({ body: { version: 1, baseRev: 0, updatedAt: 1 } }, createMockResponse()),
      handler({ body: { version: 1, baseRev: 1, updatedAt: 2 } }, createMockResponse()),
    ]);

    const tempPaths = fsPromises.writeFile.mock.calls.map(([tempPath]) => tempPath);
    expect(tempPaths).toHaveLength(2);
    expect(new Set(tempPaths).size).toBe(2);
    expect(tempPaths.every((tempPath) => tempPath.includes('sessions-directories.json.tmp-'))).toBe(true);
  });

  it('removes the temp file when rename fails', async () => {
    const { app, getRoute } = createRouteRegistry();
    const { fsPromises } = createFs();
    fsPromises.rename.mockImplementation(async () => {
      throw new Error('rename failed');
    });

    registerSessionFoldersRoutes(app, {
      fsPromises,
      path,
      openchamberDataDir: '/tmp/openchamber-test',
    });

    const handler = getRoute('POST', '/api/session-folders');
    const response = createMockResponse();

    await handler({ body: { version: 1, baseRev: 0, updatedAt: 1 } }, response);

    expect(response.statusCode).toBe(500);
    expect(fsPromises.unlink).toHaveBeenCalledWith(expect.stringContaining('sessions-directories.json.tmp-'));
  });

  it('rejects stale writes with the current server state', async () => {
    const { app, getRoute } = createRouteRegistry();
    const currentState = { version: 1, rev: 3, foldersMap: { work: [] }, collapsedFolderIds: [], updatedAt: 10 };
    const { fsPromises } = createFs(JSON.stringify(currentState));

    registerSessionFoldersRoutes(app, {
      fsPromises,
      path,
      openchamberDataDir: '/tmp/openchamber-test',
    });

    const handler = getRoute('POST', '/api/session-folders');
    const response = createMockResponse();

    await handler({ body: { version: 1, baseRev: 2, foldersMap: {}, collapsedFolderIds: [], updatedAt: 11 } }, response);

    expect(response.statusCode).toBe(409);
    expect(response.body).toMatchObject({ currentRev: 3, currentState });
    expect(fsPromises.writeFile).not.toHaveBeenCalled();
  });

  it('increments revision after matching writes', async () => {
    const { app, getRoute } = createRouteRegistry();
    const { fsPromises, getStoredRaw } = createFs();

    registerSessionFoldersRoutes(app, {
      fsPromises,
      path,
      openchamberDataDir: '/tmp/openchamber-test',
    });

    const handler = getRoute('POST', '/api/session-folders');
    const response = createMockResponse();

    await handler({ body: { version: 1, baseRev: 0, foldersMap: {}, collapsedFolderIds: [], updatedAt: 11 } }, response);

    expect(response.body).toMatchObject({ success: true, rev: 1 });
    expect(JSON.parse(getStoredRaw())).toMatchObject({ rev: 1, foldersMap: {}, collapsedFolderIds: [] });
    expect(JSON.parse(getStoredRaw())).not.toHaveProperty('baseRev');
  });
});
