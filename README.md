# Miniflare dev registry watcher crashes with uncaught `EMFILE` on macOS

Upstream issue: https://github.com/cloudflare/workers-sdk/issues/17216. Versions: `miniflare` 4.20260730.0 (latest at the time), `fsevents` 2.3.3 (only to fill the FSEvents table), Node 24.22.3, pnpm 10.24.0, macOS 27.2.1 arm64.

## Steps

```sh
pnpm install --frozen-lockfile
pnpm run repro:baseline   # Miniflare ready, fetch: 200 ok, disposed cleanly
pnpm run repro            # uncaught EMFILE from the dev registry watcher
```

`pnpm run repro` sets `EXHAUST=1`, which first starts `exhaust-fsevents.js` in a separate process. That script opens 1100 FSEvents streams with the `fsevents` package (one stream per `watch()` call), filling the machine-wide table; it is killed when the repro exits. Run on macOS only. While it runs, other processes on the machine that start a new FSEvents watch may also fail.

```js
const mf = new Miniflare({
	unsafeDevRegistryPath: path.join(scratch, "registry"),
	workers: [
		{
			name: "a",
			modules: true,
			compatibilityDate: "2026-08-01",
			script: "export default { fetch: () => new Response('ok') }",
			serviceBindings: { B: { name: "b" } },
		},
	],
});
await mf.ready;
```

## Expected

The registry watcher failing should not take the dev server down. Miniflare should handle the watcher's `"error"` event: log a warning that cross-process service bindings will not pick up registry changes (or fall back to polling, which the registry already uses on Windows and which is cheap for this small directory), and keep running. This is the same class of bug as cloudflare/workers-sdk#13890, fixed for the Wrangler assets watcher in cloudflare/workers-sdk#14027; the dev registry watcher still has no `"error"` listener.

## Actual

`Miniflare` crashes with the uncaught `EMFILE` above as soon as `DevRegistry#watch` attaches its watcher. With the same exhausted FSEvents table but no external service binding (so no registry watch), Miniflare starts, serves a request and disposes cleanly, so the crash comes from the registry watcher alone.

## Analysis

[`packages/miniflare/src/shared/dev-registry.ts` L115-L137 at `41bacf7`](https://github.com/cloudflare/workers-sdk/blob/41bacf7ce166b2151c858e06289d1711e41e4ff9/packages/miniflare/src/shared/dev-registry.ts#L115-L137) (comments trimmed):

```ts
const watcher = watch(this.registryPath, {
	usePolling: process.platform === "win32",
	interval: 100,
	ignored: () => !liveness.live,
}).on("all", () => {
	this.refresh();
});
```

Chokidar 4's `FSWatcher#_handleError` emits `"error"` for any code other than `ENOENT`/`ENOTDIR` (and `EPERM`/`EACCES` with `ignorePermissionErrors`). An `EventEmitter` with no `"error"` listener throws. Adding `.on("error", ...)` that logs through `this.log` (and, for `EMFILE`/`ENOSPC`, closes the native watcher and switches to `usePolling: true`) should fix it. I read the published `miniflare@4.20260730.0` bundle and `main` at `41bacf7`; I have not patched and rebuilt Miniflare to confirm the fix. `watcher.once("ready", ...)` in the same function may also need checking, since `watch()` awaits it after the error.

## Error

On macOS, the FSEvents stream table is limited to roughly 1024 streams per machine. When it is full, Node's `fs.watch` on a directory fails with `EMFILE`. Miniflare's dev registry watcher (`DevRegistry#watch`, which watches `unsafeDevRegistryPath` whenever a worker binds to a service outside the instance) creates a chokidar watcher and listens only for `"all"`. Chokidar re-emits the `EMFILE` as an `"error"` event, nothing listens for it, and Node throws it as an uncaught exception, killing the process (in a real setup, the Vite dev server running `@cloudflare/vite-plugin`).

```
Error: EMFILE: too many open files, watch
    at FSWatcher._handle.onchange (node:internal/fs/watchers:269:21)
Emitted 'error' event on FSWatcher instance at:
    at FSWatcher._handleError (.../miniflare@4.20260730.0/node_modules/miniflare/dist/src/index.js:101804:12)
    at NodeFsHandler._boundHandleError (.../miniflare/dist/src/index.js:101032:47)
    at .../miniflare/dist/src/index.js:100925:5
    at foreach (.../miniflare/dist/src/index.js:100875:5)
    at fsWatchBroadcast (.../miniflare/dist/src/index.js:100924:3)
    at FSWatcher.<anonymous> (.../miniflare/dist/src/index.js:100965:9)
    at FSWatcher.emit (node:events:514:28)
    at FSWatcher._handle.onchange (node:internal/fs/watchers:275:12) {
  errno: -24,
  syscall: 'watch',
  code: 'EMFILE',
  filename: null
}
```

## How it was found

A multi-worker local dev stack (Vite + `@cloudflare/vite-plugin` 1.70.1 with Wrangler 4.167.0 / Miniflare 4.20260730.0, several workers talking through service bindings and the dev registry) died twice on start on 2026-11-27 on a machine running many file watchers, which had filled the FSEvents table. Vite and the Cloudflare plugin are not needed to reproduce it: plain `Miniflare` with `unsafeDevRegistryPath` and one external service binding is enough. The silent FSEvents failure on the `fsevents` side is filed separately as https://github.com/fsevents/fsevents/issues/414.

## Files

- `repro.js`: starts Miniflare with a dev registry and one external service binding; with `EXHAUST=1` it first runs `exhaust-fsevents.js`.
- `exhaust-fsevents.js`: opens 1100 FSEvents streams and holds them until killed.
