/**
 * Deliberately minimal ambient module declaration for the `ws` package's default export — the
 * already-existing runtime dependency this repository already uses in `lib/hermesClient.ts`.
 * No `@types/ws` package exists in this repository's `node_modules`, and `ws` itself ships no
 * bundled types.
 *
 * This file intentionally declares the default export as `unknown` rather than a specific
 * shape: an earlier, more specific version of this file (declaring a `WebSocketOptions`/
 * `WebSocket` interface here) was found to collide with an unrelated, differently-shaped
 * ambient `WebSocket`/`ClientOptions` declaration already present in this project's own
 * dependency tree (`vite`'s own bundled type declarations, pulled into the same TypeScript
 * program via the test suite's imports) under the web app's `tsconfig.json` specifically
 * (though not under `tsconfig.electron.json`, which restricts global ambient type inclusion
 * via its own explicit `"types": ["node"]`). Declaring the shape as `unknown` here avoids that
 * collision entirely, regardless of its exact mechanism — the real, specific shape this
 * repository actually relies on is defined locally, privately, inside
 * `electron/hermesConnection.ts` itself (see that file's own `HermesWebSocketConstructor`/
 * `HermesWebSocketClient` types), with one explicit cast at the import boundary. This file
 * produces no JavaScript output and changes no runtime behavior.
 */
declare module "ws" {
  const WebSocketDefaultExport: unknown;
  export default WebSocketDefaultExport;
}
