import { AsyncLocalStorage } from "node:async_hooks";
import { resolve } from "node:path";

interface InvocationContext {
	credentialDir: string;
	requestProjectId?: string | null;
	apiClient?: unknown;
}

const invocations = new AsyncLocalStorage<InvocationContext>();

export function getInvocationContext(): InvocationContext | undefined {
	return invocations.getStore();
}

/** Each MCP call owns its auth scope, including asynchronous tRPC batch flushes. */
export function withInvocationContext<T>(cwd: string, operation: () => T): T {
	return invocations.run({ credentialDir: resolve(cwd) }, operation);
}
