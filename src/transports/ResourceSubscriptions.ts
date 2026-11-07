import {
    classifyInboundRequest,
    SUBSCRIPTION_ID_META_KEY,
    ProtocolError,
    isJSONRPCNotification,
    isJSONRPCRequest,
    isJSONRPCResponse,
    isSpecType,
} from '@modelcontextprotocol/server';
import type {
    JSONRPCMessage,
    MessageExtraInfo,
    RequestId,
    Transport,
    TransportSendOptions,
} from '@modelcontextprotocol/server';

// SDK 2.4's public SUPPORTED_PROTOCOL_VERSIONS is legacy-only. This
// admission adapter targets the modern revision covered by this pinned SDK.
export const MODERN_SUBSCRIPTION_REVISION = '2026-07-28';

interface Ingress {
    message: JSONRPCMessage;
    extra?: MessageExtraInfo;
    interest?: Interest;
}

interface Interest {
    // Absent until the SDK, not business admission, acknowledges the request.
    uris?: readonly string[];
    abandon?: () => void;
}

/**
 * Physical-connection decorator for the SDK's stdio entry (also used by reverse).
 * It admits file dependencies before dispatch and observes the SDK's honored
 * filter. The SDK alone owns subscription routing, ACKs, stamping and fanout.
 */
export class ResourceSubscriptions implements Transport {
    onmessage?: Transport['onmessage'];
    onclose?: Transport['onclose'];
    onerror?: Transport['onerror'];
    private closed = false;
    private readonly incoming: Ingress[] = [];
    private draining = false;
    private readonly interests = new Map<RequestId, Interest>();
    // References to forwarded generations awaiting SDK ACK/error. A cancelled
    // generation must remain here until its reply so ID reuse cannot steal it.
    private readonly awaiting = new Map<RequestId, Interest[]>();

    constructor(
        private readonly wire: Transport,
        private readonly validate?: (uri: string) => Promise<void>,
    ) {}

    /** Distinct, currently SDK-acknowledged URI dependencies; no refcount mirror. */
    readonly resourceSubscriptions = (): Iterable<string> => {
        const uris = new Set<string>();
        for (const interest of this.interests.values())
            for (const uri of interest.uris ?? []) uris.add(uri);
        return uris;
    };

    get sessionId() {
        return this.wire.sessionId;
    }
    get hasPerRequestStream() {
        return this.wire.hasPerRequestStream;
    }
    setProtocolVersion(version: string) {
        this.wire.setProtocolVersion?.(version);
    }
    setSupportedProtocolVersions(versions: string[]) {
        this.wire.setSupportedProtocolVersions?.(versions);
    }

    start(): Promise<void> {
        this.wire.onmessage = (message, extra) => this.receive(message, extra);
        this.wire.onerror = (error) => this.onerror?.(error);
        this.wire.onclose = () => {
            this.clear();
            this.onclose?.();
        };
        return this.wire.start();
    }

    async close(): Promise<void> {
        this.clear();
        await this.wire.close();
    }

    async send(
        message: JSONRPCMessage,
        options?: TransportSendOptions,
    ): Promise<void> {
        // Commit the observed ACK synchronously, BEFORE raw.send can yield or
        // cause a mutation. Failed old sends must not remove a reused ID.
        const association = this.observe(message);
        try {
            await this.wire.send(message, options);
        } catch (error) {
            if (association) this.forget(association.id, association.interest);
            throw error;
        }
    }

    private receive(message: JSONRPCMessage, extra?: MessageExtraInfo) {
        if (this.closed) return;
        if (
            isJSONRPCNotification(message) &&
            message.method === 'notifications/cancelled'
        ) {
            const id = message.params?.requestId;
            if (isSpecType.RequestId(id)) {
                const interest = this.interests.get(id);
                if (interest) this.forget(id, interest);
            }
            // SDK cancellation produces no completion frame. Do not wait for
            // one, or hold an active cancellation behind filesystem admission.
            // A cancellation of a queued ordinary request must follow that
            // request. Otherwise it can overtake a slow file preflight and the
            // SDK would receive the cancellation before it knows the request.
            if (
                this.incoming.some(
                    (entry) =>
                        !entry.interest &&
                        isJSONRPCRequest(entry.message) &&
                        entry.message.id === id,
                )
            ) {
                this.incoming.push({ message, extra });
            } else {
                this.onmessage?.(message, extra);
            }
            return;
        }

        const listen =
            isJSONRPCRequest(message) &&
            message.method === 'subscriptions/listen' &&
            validListen(message);
        const interest: Interest | undefined = listen ? {} : undefined;
        if (interest && isJSONRPCRequest(message))
            this.interests.set(message.id, interest);

        this.incoming.push({ message, extra, interest });
        void this.drain();
    }

    private async drain() {
        if (this.draining) return;
        this.draining = true;
        try {
            while (!this.closed && this.incoming.length) {
                const entry = this.incoming.shift()!;
                try {
                    await this.deliver(entry);
                } catch (error) {
                    this.onerror?.(
                        error instanceof Error
                            ? error
                            : new Error(
                                  'Resource subscription transport failed',
                              ),
                    );
                }
            }
        } finally {
            this.draining = false;
        }
    }

    private async deliver({ message, extra, interest }: Ingress) {
        if (interest && isJSONRPCRequest(message)) {
            const id = message.id;
            if (this.interests.get(id) !== interest) return;
            const abandoned = new Promise<void>((resolve) => {
                interest.abandon = resolve;
            });
            try {
                // Cancellation/close releases ingress without waiting for an
                // uninterruptible filesystem promise to settle.
                await Promise.race([
                    this.preflight(message.params?.notifications, id, interest),
                    abandoned,
                ]);
            } catch (error) {
                if (this.closed || this.interests.get(id) !== interest) return;
                this.forget(id, interest);
                // The injected business validator supplies sanitized RPC
                // errors. Never expose an arbitrary exception's message.
                const failure =
                    error instanceof ProtocolError
                        ? error
                        : new ProtocolError(
                              -32603,
                              'Resource subscription validation failed',
                          );
                await this.wire.send({
                    jsonrpc: '2.0',
                    id,
                    error: {
                        code: failure.code,
                        message: failure.message,
                        ...(failure.data !== undefined
                            ? { data: failure.data }
                            : {}),
                    },
                });
                return;
            } finally {
                interest.abandon = undefined;
            }
            if (this.closed || this.interests.get(id) !== interest) return;
            const queue = this.awaiting.get(id) ?? [];
            queue.push(interest);
            this.awaiting.set(id, queue);
        }
        this.onmessage?.(message, extra);
    }

    private async preflight(
        filter: unknown,
        id: RequestId,
        interest: Interest,
    ) {
        if (!this.validate || !isSpecType.SubscriptionFilter(filter)) return;
        for (const uri of new Set(filter.resourceSubscriptions ?? [])) {
            if (this.closed || this.interests.get(id) !== interest) return;
            await this.validate(uri);
        }
    }

    private observe(message: JSONRPCMessage) {
        if (this.closed) return;
        if (
            isJSONRPCNotification(message) &&
            isSpecType.SubscriptionsAcknowledgedNotification(message)
        ) {
            const id = message.params._meta?.[SUBSCRIPTION_ID_META_KEY];
            if (!isSpecType.RequestId(id)) return;
            const interest = this.shift(id);
            if (!interest) return;
            if (this.interests.get(id) === interest)
                interest.uris =
                    message.params.notifications.resourceSubscriptions ?? [];
            return { id, interest };
        }
        if (isJSONRPCResponse(message) && isSpecType.RequestId(message.id)) {
            // Listen completes with an empty result in SDK 2.4; an in-band
            // error (e.g. capacity) must never create dependencies.
            if (
                'result' in message &&
                message.result.resultType !== undefined &&
                message.result.resultType !== 'complete'
            )
                return;
            const interest =
                this.shift(message.id) ?? this.interests.get(message.id);
            if (interest) this.forget(message.id, interest);
        }
    }

    private shift(id: RequestId) {
        const queue = this.awaiting.get(id);
        const interest = queue?.shift();
        if (queue?.length === 0) this.awaiting.delete(id);
        return interest;
    }

    private forget(id: RequestId, interest: Interest) {
        if (this.interests.get(id) !== interest) return;
        this.interests.delete(id);
        interest.abandon?.();
    }

    private clear() {
        this.closed = true;
        for (const interest of this.interests.values()) interest.abandon?.();
        this.interests.clear();
        this.awaiting.clear();
        this.incoming.length = 0;
    }
}

/** Leave malformed filters/envelopes to the SDK; never mask them with file I/O. */
function validListen(message: JSONRPCMessage): boolean {
    // The public body classifier applies the SDK's envelope/era rules; no
    // private codec or second copy of the reserved metadata fields.
    const classified = classifyInboundRequest({
        httpMethod: 'POST',
        body: message,
    });
    return (
        classified.kind === 'modern' &&
        classified.classification.revision === MODERN_SUBSCRIPTION_REVISION &&
        classified.messageKind === 'request' &&
        isSpecType.SubscriptionFilter(classified.message.params?.notifications)
    );
}
