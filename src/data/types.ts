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
