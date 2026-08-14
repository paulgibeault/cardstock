// A PEER NETWORK IN MEMORY, so the protocol can be driven headlessly.
//
// The storage adapter's tests stub `Arcade.state` with a Map and the whole save
// layer becomes testable in Node; this is the same trick for `Arcade.peer`, and
// it is the reason src/match/ takes a "peer port" rather than reaching for the
// SDK. Two real browsers can only tell you that the happy path works. The cases
// worth pinning — a spoofed authority frame, a dropped view, a replay queue
// that overflowed, a proposal from the wrong seat — are all trivial here and
// awkward or impossible there.
//
// WHAT IT MODELS FAITHFULLY, because the protocol leans on it:
//   * a STAR: joiners hold one direct link (the host); the host holds one to
//     each joiner. A joiner's roster therefore contains ONLY the host, which
//     is the transport's real shape and the thing host discovery depends on.
//   * `relayed` on anything that went joiner → host → joiner, so the spoof
//     check has something true to check.
//   * `send` returning false for an unknown target or a dead link — the error
//     path, which is otherwise never exercised.
//   * targeted delivery that non-addressees genuinely never receive, so a
//     privacy test can assert on what a device was actually handed.
//
// WHAT IT DELIBERATELY DOES NOT MODEL: ordering guarantees, exactly-once
// replay, the 1000-frame outbox. Those are the transport's, they are tested in
// the launcher's own suite, and re-implementing them here would mean testing
// this file rather than the protocol.

/**
 * Create a network. Every device on it can reach the host; joiners cannot reach
 * each other directly.
 *
 * TWO HUBS IS A REAL SHAPE, not an exotic one. A party can contain two people
 * each hosting their own table, and then a third device holds TWO direct links
 * — which is precisely the case that broke host discovery, because "the device
 * we hold a direct link to" stopped having one answer. Pass `hostDeviceIds` to
 * model it. The single-host default is unchanged, and so is every test that
 * uses it.
 */
export function createPeerNetwork({ hostDeviceId = 'host', hostDeviceIds = null } = {}) {
  const devices = new Map(); // deviceId -> device
  const log = []; // every delivery, for privacy assertions
  const hubs = new Set(hostDeviceIds?.length ? hostDeviceIds : [hostDeviceId]);

  function isHost(deviceId) {
    return hubs.has(deviceId);
  }

  function linksOf(deviceId) {
    // The star. A joiner sees the hosts and nothing else; a host sees everyone,
    // including a second host it shares the party with.
    if (isHost(deviceId)) return [...devices.keys()].filter((id) => id !== deviceId);
    return [...hubs].filter((id) => devices.has(id));
  }

  function deliver(toId, payload, fromId, { relayed }) {
    const target = devices.get(toId);
    if (!target || !target.up) return false;
    log.push({ to: toId, from: fromId, payload: JSON.parse(JSON.stringify(payload)), relayed });
    for (const fn of [...target.handlers.message]) {
      fn(JSON.parse(JSON.stringify(payload)), fromId, { relayed, to: 'me' });
    }
    return true;
  }

  function createDevice(deviceId, { name = deviceId } = {}) {
    const device = {
      deviceId,
      name,
      up: true,
      status: 'connected',
      overflowed: false,
      handlers: { message: new Set(), ready: new Set(), peersChange: new Set(), status: new Set() },
    };
    devices.set(deviceId, device);

    const port = {
      self: () => ({ deviceId, name }),
      status: () => (device.up ? device.status : 'idle'),
      caps: () => ['peer.sendTo', 'peer.roster', 'peer.meta', 'peer.party'],
      party: () => ({ id: 'party-1', leaderName: devices.get(hostDeviceId)?.name || 'host' }),
      peers: () => linksOf(deviceId)
        .filter((id) => devices.get(id)?.up)
        .map((id) => ({
          deviceId: id,
          name: devices.get(id).name,
          status: devices.get(id).status,
          // Direct is the whole basis of host discovery: from a joiner, only
          // the host is direct.
          direct: true,
        })),
      queue: () => ({ depth: 0, limit: 1000, overflowed: device.overflowed }),

      send(payload, opts) {
        if (!device.up) return false;
        const to = opts?.to;
        if (to === undefined || to === null) {
          // Broadcast reaches this device's own party. From a joiner that is
          // the host; from the host it is every joiner.
          let any = false;
          for (const id of linksOf(deviceId)) {
            if (deliver(id, payload, deviceId, { relayed: false })) any = true;
          }
          // The hub forwards a joiner's broadcast on to the other joiners.
          if (!isHost(deviceId)) {
            for (const id of devices.keys()) {
              if (id === deviceId || isHost(id)) continue;
              if (deliver(id, payload, deviceId, { relayed: true })) any = true;
            }
          }
          return any;
        }
        if (!devices.has(to) || !devices.get(to).up) return false; // the error path
        const relayed = !isHost(deviceId) && !isHost(to);
        return deliver(to, payload, deviceId, { relayed });
      },

      onMessage(fn) { device.handlers.message.add(fn); return () => device.handlers.message.delete(fn); },
      onReady(fn) { device.handlers.ready.add(fn); return () => device.handlers.ready.delete(fn); },
      onPeersChange(fn) { device.handlers.peersChange.add(fn); return () => device.handlers.peersChange.delete(fn); },
      onStatus(fn) { device.handlers.status.add(fn); return () => device.handlers.status.delete(fn); },
    };

    device.port = port;
    return port;
  }

  return {
    createDevice,
    log,
    /** Everything a device was actually handed — the basis of a privacy assertion. */
    deliveredTo(deviceId) {
      return log.filter((entry) => entry.to === deviceId).map((entry) => entry.payload);
    },
    /** Fire `onReady` on a device, the way the SDK does when a peer mounts this game. */
    ready(deviceId, aboutId) {
      const device = devices.get(deviceId);
      if (!device) return;
      for (const fn of [...device.handlers.ready]) fn({ deviceId: aboutId });
    },
    peersChanged(deviceId) {
      const device = devices.get(deviceId);
      if (!device) return;
      for (const fn of [...device.handlers.peersChange]) fn(device.port.peers());
    },
    /** Take a device off the air without removing it — an interrupted link. */
    setStatus(deviceId, status) {
      const device = devices.get(deviceId);
      if (!device) return;
      device.status = status;
      for (const fn of [...device.handlers.status]) fn(status);
    },
    drop(deviceId) {
      const device = devices.get(deviceId);
      if (device) device.up = false;
    },
    restore(deviceId) {
      const device = devices.get(deviceId);
      if (device) device.up = true;
    },
    setOverflowed(deviceId, value) {
      const device = devices.get(deviceId);
      if (device) device.overflowed = value;
    },
    clearLog() { log.length = 0; },
  };
}
