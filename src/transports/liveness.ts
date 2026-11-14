import { PingRequestSchema } from '@modelcontextprotocol/core';
import {
    classifyInboundRequest,
    isJSONRPCRequest,
    isSpecType,
} from '@modelcontextprotocol/server';
import type { JSONRPCMessage } from '@modelcontextprotocol/server';

/** Only read-only probes understood by the pinned SDK, never method-name alone. */
export function livenessRequest(
    message: JSONRPCMessage,
): 'ping' | 'discover' | undefined {
    if (!isJSONRPCRequest(message)) return;
    if (message.method === 'ping') {
        if (PingRequestSchema.safeParse(message).success) return 'ping';
        return;
    }
    if (message.method !== 'server/discover') return;
    const classified = classifyInboundRequest({
        httpMethod: 'POST',
        body: message,
    });
    if (
        classified.kind === 'modern' &&
        classified.classification.revision === '2026-07-28' &&
        classified.messageKind === 'request' &&
        isSpecType.DiscoverRequest(message)
    )
        return 'discover';
}
