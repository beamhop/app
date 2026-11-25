/* tslint:disable */
/* eslint-disable */

export class Conn {
    free(): void;
    [Symbol.dispose](): void;
    alpn(): Uint8Array | undefined;
    cipher_suite(): string;
    err_class(): number;
    err_msg(): string;
    /**
     * Feed ciphertext from the transport. Returns 0, or an error class (sticky). Afterwards the
     * caller must drain `take_tls()` (also on error: it holds the alert) and `take_plain()`.
     */
    feed(data: Uint8Array | number[], now_secs: number): number;
    is_handshaking(): boolean;
    /**
     * `alpn_wire`: concatenated `u8 len | protocol` entries, in preference order.
     * `versions`: bit 0 = TLS 1.2, bit 1 = TLS 1.3.
     */
    constructor(roots: Roots, server_name: string, alpn_wire: Uint8Array | number[], versions: number, now_secs: number);
    /**
     * True once the peer's close_notify alert has been received.
     */
    peer_closed(): boolean;
    send_close_notify(): void;
    take_plain(): Uint8Array;
    take_tls(): Uint8Array;
    /**
     * Negotiated protocol version on the wire (0x0303 / 0x0304), 0 if not yet known.
     */
    version(): number;
    /**
     * Encrypt application data. Returns false if the connection cannot accept it.
     */
    write(data: Uint8Array | number[]): boolean;
}

export class Roots {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Add trust anchors in the packed form produced by `pack_anchor` (concatenated).
     */
    add_packed(packed: Uint8Array | number[]): void;
    len(): number;
    constructor();
}

/**
 * Extract the trust-anchor fields (subject, SPKI, name constraints) from a DER certificate using
 * webpki, in the packed form `Roots::add_packed` accepts:
 * repeated `u16be len | subject`, `u16be len | spki`, `u16be len | nameConstraints (may be empty)`.
 */
export function pack_anchor(cert_der: Uint8Array | number[]): Uint8Array;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_conn_free: (a: number, b: number) => void;
    readonly __wbg_roots_free: (a: number, b: number) => void;
    readonly conn_alpn: (a: number, b: number) => void;
    readonly conn_cipher_suite: (a: number, b: number) => void;
    readonly conn_err_class: (a: number) => number;
    readonly conn_err_msg: (a: number, b: number) => void;
    readonly conn_feed: (a: number, b: number, c: number, d: number) => number;
    readonly conn_is_handshaking: (a: number) => number;
    readonly conn_new: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => void;
    readonly conn_peer_closed: (a: number) => number;
    readonly conn_send_close_notify: (a: number) => void;
    readonly conn_take_plain: (a: number, b: number) => void;
    readonly conn_take_tls: (a: number, b: number) => void;
    readonly conn_version: (a: number) => number;
    readonly conn_write: (a: number, b: number, c: number) => number;
    readonly pack_anchor: (a: number, b: number, c: number) => void;
    readonly roots_add_packed: (a: number, b: number, c: number, d: number) => void;
    readonly roots_len: (a: number) => number;
    readonly roots_new: () => number;
    readonly ring_core_0_17_14__bn_mul_mont: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly __wbindgen_export: (a: number) => void;
    readonly __wbindgen_export2: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
    readonly __wbindgen_export3: (a: number, b: number, c: number) => void;
    readonly __wbindgen_export4: (a: number, b: number) => number;
    readonly __wbindgen_export5: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_export6: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
