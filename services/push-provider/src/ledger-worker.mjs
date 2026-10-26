import { authenticateLedger, ledgerError, ledgerRoute, handleLedgerRequest, PUSH_LEDGER_PROJECT } from './durable-ledger.mjs';

export class PushDispatchLedger {
  #storage; #env;
  constructor(context, env) { this.#storage = context.storage; this.#env = env; }
  fetch(request) { return handleLedgerRequest(request, this.#env, this.#storage); }
}

export default {
  async fetch(request, env) {
    try {
      const route = ledgerRoute(request);
      // Both authentication layers precede body consumption or namespace access.
      await authenticateLedger(request, env, route.kind === 'bootstrap');
      const namespace = env.PUSH_DISPATCH_LEDGER.jurisdiction('eu');
      // The object name never derives from a caller, operation or ledger ID.
      const id = namespace.idFromName('lovelies-push-dispatch-ledger-v1:' + PUSH_LEDGER_PROJECT);
      return await namespace.get(id).fetch(request);
    } catch (error) { return ledgerError(error); }
  },
};
