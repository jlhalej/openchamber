import { beforeEach, describe, expect, mock, test } from 'bun:test';

const storage = new Map<string, string>();
let storageSetCount = 0;

const safeStorage = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => {
    storageSetCount += 1;
    storage.set(key, value);
  },
  removeItem: (key: string) => {
    storage.delete(key);
  },
  clear: () => {
    storage.clear();
  },
  key: (index: number) => Array.from(storage.keys())[index] ?? null,
  get length() {
    return storage.size;
  },
} as Storage;

type RuntimeFetchHandler = (input?: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const defaultRuntimeFetchHandler: RuntimeFetchHandler = async () => new Response('{"rev":0,"foldersMap":{},"collapsedFolderIds":[]}', {
  headers: { 'Content-Type': 'application/json' },
});
let runtimeFetchHandler: RuntimeFetchHandler = defaultRuntimeFetchHandler;
const runtimeFetchMock = mock((input?: RequestInfo | URL, init?: RequestInit) => runtimeFetchHandler(input, init));

if (typeof window === 'undefined') {
  Object.defineProperty(globalThis, 'window', {
    value: {
      addEventListener: () => {},
    },
    configurable: true,
  });
}

mock.module('./utils/safeStorage', () => ({
  getDeferredSafeStorage: () => safeStorage,
  getSafeStorage: () => safeStorage,
}));

mock.module('@/lib/desktop', () => ({
  isVSCodeRuntime: () => false,
}));

mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: runtimeFetchMock,
}));

const { useSessionFoldersStore } = await import('./useSessionFoldersStore');

const waitForPersist = () => new Promise((resolve) => setTimeout(resolve, 350));

describe('useSessionFoldersStore folder assignments', () => {
  beforeEach(() => {
    storage.clear();
    storageSetCount = 0;
    runtimeFetchHandler = defaultRuntimeFetchHandler;
    useSessionFoldersStore.setState({
      foldersMap: {},
      collapsedFolderIds: new Set<string>(),
    });
  });

  test('repeated addSessionToFolder to the same folder preserves foldersMap reference', async () => {
    const store = useSessionFoldersStore.getState();
    const folder = store.createFolder('/workspace/project', 'Work');
    store.addSessionToFolder('/workspace/project', folder.id, 'ses_1');
    await waitForPersist();
    storageSetCount = 0;

    const before = useSessionFoldersStore.getState().foldersMap;
    useSessionFoldersStore.getState().addSessionToFolder('/workspace/project', folder.id, 'ses_1');
    await waitForPersist();

    expect(useSessionFoldersStore.getState().foldersMap).toBe(before);
    expect(storageSetCount).toBe(0);
  });

  test('repeated addSessionsToFolder to the same folder preserves foldersMap reference', async () => {
    const store = useSessionFoldersStore.getState();
    const folder = store.createFolder('/workspace/project', 'Batch');
    store.addSessionsToFolder('/workspace/project', folder.id, ['ses_1', 'ses_2']);
    await waitForPersist();
    storageSetCount = 0;

    const before = useSessionFoldersStore.getState().foldersMap;
    useSessionFoldersStore.getState().addSessionsToFolder('/workspace/project', folder.id, ['ses_1', 'ses_2']);
    await waitForPersist();

    expect(useSessionFoldersStore.getState().foldersMap).toBe(before);
    expect(storageSetCount).toBe(0);
  });

  test('reloads server folder state after a stale disk write conflict', async () => {
    const serverFolders = {
      '/workspace/project': [{
        id: 'server-folder',
        name: 'Server folder',
        sessionIds: ['ses_server'],
        createdAt: 1,
        parentId: null,
      }],
    };

    runtimeFetchHandler = async (_input: RequestInfo | URL | undefined, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return new Response(JSON.stringify({
          error: 'Session folders changed on the server',
          currentRev: 3,
          currentState: {
            version: 1,
            rev: 3,
            foldersMap: serverFolders,
            collapsedFolderIds: ['server-folder'],
            updatedAt: 10,
          },
        }), {
          status: 409,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return new Response(JSON.stringify({
        version: 1,
        rev: 2,
        foldersMap: {},
        collapsedFolderIds: [],
        updatedAt: 1,
      }), { headers: { 'Content-Type': 'application/json' } });
    };

    useSessionFoldersStore.getState().createFolder('/workspace/project', 'Local stale folder');
    await waitForPersist();

    expect(useSessionFoldersStore.getState().foldersMap).toEqual(serverFolders);
    expect(useSessionFoldersStore.getState().collapsedFolderIds).toEqual(new Set(['server-folder']));
  });
});
