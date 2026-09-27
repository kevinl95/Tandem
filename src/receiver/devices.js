const ALLOWED_KEY = "tandem.trustedSenders";
const BLOCKED_KEY = "tandem.blockedSenders";
// After a Decline, the same device can't prompt again for this long.
export const DECLINE_COOLDOWN_MS = 60 * 1000;

// The TV's lists of allowed and blocked sender devices, keyed by client id and
// kept in storage (localStorage on the TV). Storage may be unavailable, in
// which case the lists live only for this session.
export function createDeviceStore(storage, now = () => Date.now()) {
  const memory = new Map();
  const recentDeclines = new Map();

  function read(key) {
    try {
      const parsed = JSON.parse(storage.getItem(key));
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return memory.get(key) ?? [];
    }
  }

  function write(key, devices) {
    memory.set(key, devices);
    try {
      storage.setItem(key, JSON.stringify(devices));
    } catch {
      // Keep the in-memory copy.
    }
  }

  function without(key, clientId) {
    return read(key).filter((device) => device.clientId !== clientId);
  }

  return {
    isTrusted(clientId) {
      return read(ALLOWED_KEY).some((device) => device.clientId === clientId);
    },

    isBlocked(clientId) {
      const declinedAt = recentDeclines.get(clientId);
      const coolingDown = declinedAt !== undefined && now() - declinedAt < DECLINE_COOLDOWN_MS;
      return coolingDown || read(BLOCKED_KEY).some((device) => device.clientId === clientId);
    },

    allow(clientId, name) {
      write(BLOCKED_KEY, without(BLOCKED_KEY, clientId));
      write(ALLOWED_KEY, [...without(ALLOWED_KEY, clientId), { clientId, name }]);
    },

    block(clientId, name) {
      write(ALLOWED_KEY, without(ALLOWED_KEY, clientId));
      write(BLOCKED_KEY, [...without(BLOCKED_KEY, clientId), { clientId, name }]);
    },

    noteDeclined(clientId) {
      recentDeclines.set(clientId, now());
    },

    forget(clientId) {
      write(ALLOWED_KEY, without(ALLOWED_KEY, clientId));
      write(BLOCKED_KEY, without(BLOCKED_KEY, clientId));
      recentDeclines.delete(clientId);
    },

    forgetAll() {
      write(ALLOWED_KEY, []);
      write(BLOCKED_KEY, []);
      recentDeclines.clear();
    },

    list() {
      return { allowed: read(ALLOWED_KEY), blocked: read(BLOCKED_KEY) };
    },
  };
}
