import net from "net";

const RFB_BANNER_LENGTH = 12;
const VNC_AUTH_SECURITY_TYPE = 2;
const MACOS_RFB_BANNER = Buffer.from("RFB 003.889\n", "ascii");
const STANDARD_RFB_BANNER = Buffer.from("RFB 003.008\n", "ascii");

/**
 * Settings a Mac does better with: it draws its own pointer lag-free with a
 * local cursor, and 16 bpp cut its screen traffic about 4x in testing (#5).
 * A host can still pick its own.
 */
export const MACOS_VNC_DEFAULTS = { cursor: "local", "color-depth": 16 };

/**
 * Whether a VNC server announces itself as macOS Screen Sharing. Only reads
 * the 12-byte banner, then hangs up; any failure or silence counts as "no".
 */
export function isMacosVncServer(
  host: string,
  port: number,
  timeoutMs = 2000,
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection(port, host);
    let received = Buffer.alloc(0);
    const finish = (isMacos: boolean) => {
      socket.destroy();
      resolve(isMacos);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once("error", () => finish(false));
    socket.once("close", () => finish(false));
    socket.on("data", (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      if (received.length >= RFB_BANNER_LENGTH) {
        finish(
          received.subarray(0, RFB_BANNER_LENGTH).equals(MACOS_RFB_BANNER),
        );
      }
    });
  });
}

export interface VncCompatibilityProxy {
  port: number;
  close: () => void;
}

export async function createMacosVncCompatibilityProxy({
  targetHost,
  targetPort,
  bindHost,
}: {
  targetHost: string;
  targetPort: number;
  bindHost: string;
}): Promise<VncCompatibilityProxy> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((client) => {
    const upstream = net.createConnection(targetPort, targetHost);
    // RFB input is many tiny writes; Nagle would hold them back for an ACK.
    client.setNoDelay(true);
    upstream.setNoDelay(true);
    sockets.add(client);
    sockets.add(upstream);

    const forget = (socket: net.Socket) => sockets.delete(socket);
    client.once("close", () => forget(client));
    upstream.once("close", () => forget(upstream));
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
    client.once("close", () => upstream.destroy());
    upstream.once("close", () => client.destroy());
    client.pipe(upstream);

    let pending = Buffer.alloc(0);
    const forwardMacosSecurityTypes = (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      if (pending.length < 1) return;

      const securityTypeCount = pending[0];
      if (securityTypeCount === 0) {
        upstream.off("data", forwardMacosSecurityTypes);
        client.write(pending);
        upstream.pipe(client);
        return;
      }
      if (pending.length < 1 + securityTypeCount) return;

      upstream.off("data", forwardMacosSecurityTypes);
      const securityTypes = pending.subarray(1, 1 + securityTypeCount);
      if (securityTypes.includes(VNC_AUTH_SECURITY_TYPE)) {
        client.write(Buffer.from([1, VNC_AUTH_SECURITY_TYPE]));
      } else {
        client.write(pending.subarray(0, 1 + securityTypeCount));
      }
      client.write(pending.subarray(1 + securityTypeCount));
      upstream.pipe(client);
    };

    const forwardServerBanner = (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      if (pending.length < RFB_BANNER_LENGTH) return;

      upstream.off("data", forwardServerBanner);
      const banner = pending.subarray(0, RFB_BANNER_LENGTH);
      const remainder = pending.subarray(RFB_BANNER_LENGTH);
      if (banner.equals(MACOS_RFB_BANNER)) {
        client.write(STANDARD_RFB_BANNER);
        pending = Buffer.alloc(0);
        upstream.on("data", forwardMacosSecurityTypes);
        if (remainder.length > 0) forwardMacosSecurityTypes(remainder);
      } else {
        client.write(banner);
        client.write(remainder);
        upstream.pipe(client);
      }
    };
    upstream.on("data", forwardServerBanner);
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, bindHost, () => {
      server.off("error", reject);
      resolve((server.address() as net.AddressInfo).port);
    });
  });
  server.unref();

  return {
    port,
    close: () => {
      server.close();
      for (const socket of sockets) socket.destroy();
    },
  };
}
