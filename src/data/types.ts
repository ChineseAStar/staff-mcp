/** Byte interfaces only. Resource authorization and lifetime belong to the caller. */
/** Nonempty purpose identifier, bounded to 256 characters at the wire boundary. */
export type ChannelPurpose = string;
export type Direction = 'host-to-remote' | 'remote-to-host' | 'duplex';

export interface ChannelOpen {
    purpose: ChannelPurpose;
    resourceId: string;
    direction: Direction;
}

export interface DataChannel {
    write(bytes: Uint8Array): Promise<void>;
    end(): Promise<void>;
    close(code?: string): void;
    readonly closed: Promise<void>;
}

export interface ChannelReceiver {
    data(bytes: Uint8Array): Promise<void>;
    end(): Promise<void> | void;
    close(reason?: Error): void;
}

export interface DataLink {
    version: 1;
    endpoint: string;
    channel: string;
    token: string;
    binding: string;
    open: ChannelOpen;
    expiresInMs: number;
}

export interface DataOpenParams {
    open: ChannelOpen;
    binding: string;
    link?: DataLink;
}

export interface DataOpenResult {
    link?: DataLink;
}

export interface HttpDataSessionOptions {
    role: 'host' | 'remote';
    binding: string;
    /** Required: inject the connection's existing proxy/CA-aware HTTP client. */
    fetch: typeof fetch;
    /** Already mounted HTTP/Next route. This module never starts a listener. */
    endpoint?: string;
    /** Optional transport-specific resolution; absent means canonical absolute URLs only. */
    resolveEndpoint?: (endpoint: string) => URL;
    /** Must enforce configured origin AND path; throw before any HTTP request. */
    validateEndpoint: (endpoint: URL) => void;
    /** Business admission policy for the current negotiated connection. */
    supportsPurpose: (purpose: string) => boolean;
    requestOpen?: (
        params: DataOpenParams,
        signal?: AbortSignal,
    ) => Promise<DataOpenResult>;
    accept?: (
        open: ChannelOpen,
        channel: DataChannel,
    ) => Promise<ChannelReceiver>;
    maxChannels?: number;
    openTimeoutMs?: number;
    idleTimeoutMs?: number;
}

/** Transport-neutral byte session; HTTP links are never valid on stdio. */
export interface DataSession {
    supports(purpose: ChannelPurpose, direction: Direction): boolean;
    openChannel(
        open: ChannelOpen,
        receiver: ChannelReceiver,
        link?: DataLink,
        signal?: AbortSignal,
    ): Promise<DataChannel>;
    acceptOpen(raw: unknown): Promise<DataOpenResult>;
    close(reason?: string): void;
}

export interface StdioDataOpenParams {
    binding: string;
    channel: number;
    open: ChannelOpen;
}

export type StdioDataFrame = {
    binding: string;
    channel: number;
} & (
    | { type: 'data'; sequence: number; offset: number; data: string }
    | { type: 'end'; sequence: number; offset: number }
    | { type: 'ack'; sequence: number; offset: number; ended: boolean }
    | { type: 'close'; code: string }
);

export interface StdioDataSessionOptions {
    role: 'host' | 'remote';
    binding: string;
    supportsPurpose: (purpose: string) => boolean;
    /** Send frame params as cc.qqxing/data/v1/frame through the FIFO transport. */
    sendNotification: (params: StdioDataFrame) => Promise<void>;
    requestOpen?: (
        params: StdioDataOpenParams,
        signal?: AbortSignal,
    ) => Promise<DataOpenResult>;
    accept?: (
        open: ChannelOpen,
        channel: DataChannel,
    ) => Promise<ChannelReceiver>;
    maxChannels?: number;
    openTimeoutMs?: number;
    /** Consumption progress deadline only while there is outstanding work. */
    idleTimeoutMs?: number;
}
