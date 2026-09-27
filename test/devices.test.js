import test from "node:test";
import assert from "node:assert/strict";
import { DECLINE_COOLDOWN_MS, createDeviceStore } from "../src/receiver/devices.js";

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    values,
  };
}

test("allowed devices persist and can be forgotten", () => {
  const storage = memoryStorage();
  const devices = createDeviceStore(storage);

  devices.allow("client-a", "Pixel");
  devices.allow("client-b", "Laptop");
  assert.equal(createDeviceStore(storage).isTrusted("client-a"), true);

  devices.forget("client-a");
  assert.equal(devices.isTrusted("client-a"), false);
  assert.deepEqual(devices.list().allowed, [{ clientId: "client-b", name: "Laptop" }]);
});

test("reads devices saved by earlier builds", () => {
  const storage = memoryStorage({
    "tandem.trustedSenders": JSON.stringify([{ clientId: "client-old", name: "Old phone" }]),
  });

  assert.equal(createDeviceStore(storage).isTrusted("client-old"), true);
});

test("blocking a device revokes its approval, and allowing unblocks it", () => {
  const devices = createDeviceStore(memoryStorage());

  devices.allow("client-a", "Pixel");
  devices.block("client-a", "Pixel");
  assert.equal(devices.isTrusted("client-a"), false);
  assert.equal(devices.isBlocked("client-a"), true);

  devices.allow("client-a", "Pixel");
  assert.equal(devices.isBlocked("client-a"), false);
  assert.equal(devices.isTrusted("client-a"), true);
});

test("a declined device can't prompt again until the cooldown passes", () => {
  let now = 1000;
  const devices = createDeviceStore(memoryStorage(), () => now);

  devices.noteDeclined("client-a");
  assert.equal(devices.isBlocked("client-a"), true);

  now += DECLINE_COOLDOWN_MS;
  assert.equal(devices.isBlocked("client-a"), false);
});

test("forget all clears allowed, blocked and cooling-down devices", () => {
  const devices = createDeviceStore(memoryStorage());
  devices.allow("client-a", "Pixel");
  devices.block("client-b", "Stranger");
  devices.noteDeclined("client-c");

  devices.forgetAll();

  assert.deepEqual(devices.list(), { allowed: [], blocked: [] });
  assert.equal(devices.isBlocked("client-c"), false);
});

test("works without storage for the current session", () => {
  const broken = {
    getItem() {
      throw new Error("storage disabled");
    },
    setItem() {
      throw new Error("storage disabled");
    },
  };
  const devices = createDeviceStore(broken);

  devices.allow("client-a", "Pixel");

  assert.equal(devices.isTrusted("client-a"), true);
});
