import { beforeEach, describe, expect, mock, test } from 'bun:test';

const storage = new Map<string, string>();
let storageSetCount = 0;
let runtimeKey = 'runtime-a';
let diskResponseBody: Record<string, unknown> = { version: 1, exists: false };

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

const defaultRuntimeFetchHandler: RuntimeFetchHandler = async () => new Response(JSON.stringify(diskResponseBody), {
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
mock.module('@/lib/runtime-switch', () => ({ getRuntimeKey: () => runtimeKey }));

const { useSessionFoldersStore } = await import('./useSessionFoldersStore');

const waitForPersist = () => new Promise((resolve) => setTimeout(resolve, 350));

describe('useSessionFoldersStore folder assignments', () => {
  beforeEach(() => {
    storage.clear();
    storageSetCount = 0;
    runtimeFetchHandler = defaultRuntimeFetchHandler;
    runtimeKey = 'runtime-a';
    diskResponseBody = { version: 1, exists: false };
    useSessionFoldersStore.getState().resetForRuntimeSwitch(runtimeKey);
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

  test('does not clear local folders when a conflict reports no server snapshot', async () => {
    runtimeKey = 'runtime-missing';
    useSessionFoldersStore.getState().resetForRuntimeSwitch(runtimeKey);

    let postCount = 0;
    runtimeFetchHandler = async (_input: RequestInfo | URL | undefined, init?: RequestInit) => {
      if (init?.method === 'POST') {
        postCount += 1;
        if (postCount === 1) {
          return new Response(JSON.stringify({
            error: 'Session folders changed on the server',
            currentRev: 0,
            currentState: {
              version: 1,
              rev: 0,
              foldersMap: {},
              collapsedFolderIds: [],
              updatedAt: 0,
              exists: false,
            },
          }), { status: 409, headers: { 'Content-Type': 'application/json' } });
        }
        return new Response(JSON.stringify({ success: true, rev: 1 }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return new Response(JSON.stringify({ version: 1, rev: 0, exists: false }), {
        headers: { 'Content-Type': 'application/json' },
      });
    };

    useSessionFoldersStore.getState().createFolder('/workspace/project', 'Local only');
    await waitForPersist();

    // A missing server snapshot is not authoritative empty state.
    expect(useSessionFoldersStore.getState().getFoldersForScope('/workspace/project').map((folder) => folder.name))
      .toEqual(['Local only']);
    // The dropped write is retried once against the reseeded revision.
    expect(postCount).toBe(2);
  });

  test('keeps the server revision even when browser state wins hydration', async () => {
    runtimeKey = 'runtime-rev';
    useSessionFoldersStore.getState().resetForRuntimeSwitch(runtimeKey);
    useSessionFoldersStore.getState().createFolder('/workspace/project', 'Newer browser folder');
    await waitForPersist();

    const postBodies: Array<Record<string, unknown>> = [];
    runtimeFetchHandler = async (_input: RequestInfo | URL | undefined, init?: RequestInit) => {
      if (init?.method === 'POST') {
        postBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return new Response(JSON.stringify({ success: true, rev: 8 }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return new Response(JSON.stringify({
        version: 1,
        exists: true,
        rev: 7,
        foldersMap: {},
        collapsedFolderIds: [],
        updatedAt: 1,
      }), { headers: { 'Content-Type': 'application/json' } });
    };

    useSessionFoldersStore.getState().resetForRuntimeSwitch(runtimeKey);
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Browser state is newer than the disk snapshot, so hydration must not adopt disk...
    expect(useSessionFoldersStore.getState().getFoldersForScope('/workspace/project').map((folder) => folder.name))
      .toEqual(['Newer browser folder']);

    useSessionFoldersStore.getState().createFolder('/workspace/project', 'Second folder');
    await waitForPersist();

    // ...but the next write must still carry the server revision, or it 409s and
    // the newer browser state gets discarded for older disk state.
    expect(postBodies.at(-1)?.baseRev).toBe(7);
  });

  test('restores independent folder snapshots across runtime switches', async () => {
    useSessionFoldersStore.getState().createFolder('/workspace/project', 'Runtime A');
    await waitForPersist();

    runtimeKey = 'runtime-b';
    useSessionFoldersStore.getState().resetForRuntimeSwitch(runtimeKey);
    expect(useSessionFoldersStore.getState().getFoldersForScope('/workspace/project')).toEqual([]);
    useSessionFoldersStore.getState().createFolder('/workspace/project', 'Runtime B');
    await waitForPersist();

    runtimeKey = 'runtime-a';
    useSessionFoldersStore.getState().resetForRuntimeSwitch(runtimeKey);
    expect(useSessionFoldersStore.getState().getFoldersForScope('/workspace/project').map((folder) => folder.name)).toEqual(['Runtime A']);
  });

  test('flushes the outgoing runtime before a debounced browser write can be lost', () => {
    useSessionFoldersStore.getState().createFolder('/workspace/project', 'Runtime A pending');

    runtimeKey = 'runtime-b';
    useSessionFoldersStore.getState().resetForRuntimeSwitch(runtimeKey);
    runtimeKey = 'runtime-a';
    useSessionFoldersStore.getState().resetForRuntimeSwitch(runtimeKey);

    expect(useSessionFoldersStore.getState().getFoldersForScope('/workspace/project').map((folder) => folder.name)).toEqual(['Runtime A pending']);
  });

  test('does not replace browser folders when the server has no disk snapshot', async () => {
    useSessionFoldersStore.getState().createFolder('/workspace/project', 'Browser folder');
    runtimeKey = 'runtime-b';
    useSessionFoldersStore.getState().resetForRuntimeSwitch(runtimeKey);
    runtimeKey = 'runtime-a';
    useSessionFoldersStore.getState().resetForRuntimeSwitch(runtimeKey);

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(useSessionFoldersStore.getState().getFoldersForScope('/workspace/project').map((folder) => folder.name)).toEqual(['Browser folder']);
  });

  test('does not silently evict folder state from older runtimes', () => {
    for (let index = 0; index < 10; index += 1) {
      runtimeKey = `runtime-${index}`;
      useSessionFoldersStore.getState().resetForRuntimeSwitch(runtimeKey);
      useSessionFoldersStore.getState().createFolder('/workspace/project', `Folder ${index}`);
    }

    runtimeKey = 'runtime-0';
    useSessionFoldersStore.getState().resetForRuntimeSwitch(runtimeKey);
    expect(useSessionFoldersStore.getState().getFoldersForScope('/workspace/project').map((folder) => folder.name)).toEqual(['Folder 0']);
  });
});
