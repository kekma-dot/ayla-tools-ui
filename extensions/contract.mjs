// Bundled verbatim copy of ayla-tools-contract 0.1.0 (MIT, kekma-dot).
// Source: pi-ayla-contract @ af75d954 (standalone package ayla-tools-contract,
// index.mjs sha256 b5762bdcf4972ab6ea8256a33e17496e68c4f7d37c05ec21c1bd5bd286db6478).
// Bundled because the standalone package is not published to npm. The
// Symbol.for("ayla.footer.signals.v1") singleton key is unchanged, so this copy
// shares one process-wide store with any other co-loaded copy of the contract.

// Shared producer contract: no Pi SDK, UI, I/O or timers.
const SLOT = Symbol.for("ayla.footer.signals.v1");
function emptyStore() {
  return { quota: null, voice: null, memory: null, transport: null, working: null };
}
export function signalStore() {
  const holder = globalThis;
  if (!holder[SLOT]) holder[SLOT] = emptyStore();
  return holder[SLOT];
}
/** Each producer owns one scope. undefined clears only that scope. */
export function publishSignal(scope, value) {
  signalStore()[scope] = value === undefined ? null : value;
}
export function readSignals() {
  const store = signalStore();
  return { quota: store.quota, voice: store.voice, memory: store.memory, transport: store.transport, working: store.working };
}
/** Test helper only; production consumers must not erase other producers. */
export function resetSignals() {
  globalThis[SLOT] = emptyStore();
}
export function formatCountdown(ms) {
  const left = Number(ms);
  if (!Number.isFinite(left) || left <= 0) return "";
  const minutes = Math.round(left / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) {
    const rest = minutes % 60;
    return rest > 0 ? `${hours}h${rest}m` : `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours > 0 ? `${days}d${restHours}h` : `${days}d`;
}
