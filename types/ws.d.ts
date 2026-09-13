/**
 * Minimal local ambient declaration for the `ws` package's runtime surface actually used by
 * lib/hermesClient.ts — deliberately hand-written instead of installing `@types/ws`, per
 * VYRON_CODE_V01_HERMES_WS_DEPENDENCY_AND_SMOKE_TEST_AUTHORIZATION's "ws dışında başka
 * dependency ekleme" (add no dependency besides `ws` itself). `ws`'s own package.json ships
 * no "types"/"typings" field, so without this file `import WebSocket from "ws"` would not
 * type-check under this project's `strict: true` tsconfig.
 */
declare module "ws" {
  import { EventEmitter } from "node:events";

  namespace WebSocket {
    interface ClientOptions {
      origin?: string;
      headers?: Record<string, string>;
      handshakeTimeout?: number;
    }
  }

  class WebSocket extends EventEmitter {
    static readonly CONNECTING: 0;
    static readonly OPEN: 1;
    static readonly CLOSING: 2;
    static readonly CLOSED: 3;

    readonly readyState: 0 | 1 | 2 | 3;

    constructor(address: string, options?: WebSocket.ClientOptions);

    send(data: string): void;
    close(code?: number, reason?: string): void;
    terminate(): void;

    on(event: "open", listener: () => void): this;
    on(event: "message", listener: (data: unknown, isBinary: boolean) => void): this;
    on(event: "error", listener: (err: Error) => void): this;
    on(event: "close", listener: (code: number, reason: unknown) => void): this;
  }

  export = WebSocket;
}
