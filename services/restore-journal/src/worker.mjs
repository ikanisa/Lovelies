import { PROJECT_ID, authenticate, errorResponse, handleRequest, route } from './journal.mjs';
import { handleOperationRequest, operationRoute } from './operations.mjs';
import { handleInventoryRequest, inventoryRoute, authenticateInventoryRoute } from './inventory.mjs';

// Plain fetch-style Durable Object. Wrangler creates this class with the SQLite
// backend; its transactional KV API persists inside that SQLite database.
export class RestoreJournal {
  constructor(ctx, env) { this.storage = ctx.storage; this.env = env; }
  async fetch(request) {
    try {
      await authenticateInventoryRoute(request, this.env);
      return inventoryRoute(request) ? handleInventoryRequest(request, this.env, this.storage) :
        operationRoute(request) ? handleOperationRequest(request, this.env, this.storage) : handleRequest(request, this.env, this.storage);
    } catch (error) { return errorResponse(error); }
  }
}

export default {
  async fetch(request, env) {
    try {
      // Authentication precedes body reads, namespace lookup, and DO access.
      // The DO authenticates again; it exposes no alternate RPC write method.
      await authenticateInventoryRoute(request, env);
      if (!inventoryRoute(request) && !operationRoute(request)) route(request);
      const namespace = env.RESTORE_JOURNAL.jurisdiction('eu');
      const id = namespace.idFromName('lovelies-restriction-journal-v1:' + PROJECT_ID);
      return await namespace.get(id).fetch(request);
    } catch (error) { return errorResponse(error); }
  },
};
