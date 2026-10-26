import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

interface Activity {
    requests: number;
    installed: boolean;
    predicates: Set<() => boolean>;
}
const activities = new WeakMap<McpServer, Activity>();

function activityFor(server: McpServer): Activity {
    let activity = activities.get(server);
    if (!activity) {
        activity = { requests: 0, installed: false, predicates: new Set() };
        activities.set(server, activity);
    }
    return activity;
}

/** Install before business handlers. SDK-owned initialize/ping handlers stay untouched. */
export function installRequestActivity(server: McpServer): void {
    const activity = activityFor(server);
    if (activity.installed) return;
    const setRequestHandler = server.server.setRequestHandler.bind(
        server.server,
    );
    server.server.setRequestHandler = (schema, handler) => {
        setRequestHandler(schema, async (request, extra) => {
            activity.requests++;
            try {
                // Cancellation/transport closure does not settle the actual handler.
                return await handler(request, extra);
            } finally {
                activity.requests--;
            }
        });
    };
    activity.installed = true;
}

/** Predicates read their owner's existing state; they must not renew or sweep resources. */
export function registerServerActivity(
    server: McpServer,
    predicate: () => boolean,
): void {
    activityFor(server).predicates.add(predicate);
}

export function hasServerActivity(server: McpServer): boolean {
    const activity = activities.get(server);
    if (!activity) return false;
    if (activity.requests > 0) return true;
    for (const predicate of activity.predicates) {
        if (predicate()) return true;
    }
    return false;
}
