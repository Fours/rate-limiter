import net from 'node:net';

/**
 * A TCP proxy in front of the test Redis that can stop forwarding, so a test sees a Redis that
 * hangs, as `docker pause` makes one, without touching the real server: connections stay open
 * and commands get no reply. Held commands go through, in order, on resume().
 */
export interface PausableProxy {
  readonly port: number;
  pause(): void;
  resume(): void;
  close(): Promise<void>;
}

export async function startProxy(target: { host: string; port: number }): Promise<PausableProxy> {
  let paused = false;
  const held: (() => void)[] = [];
  const sockets = new Set<net.Socket>();

  const server = net.createServer((client) => {
    const upstream = net.connect(target.port, target.host);
    sockets.add(client).add(upstream);
    client.on('data', (chunk) => {
      if (paused) held.push(() => upstream.write(chunk));
      else upstream.write(chunk);
    });
    upstream.on('data', (chunk) => client.write(chunk));
    const end = () => {
      client.destroy();
      upstream.destroy();
    };
    for (const socket of [client, upstream]) socket.on('close', end).on('error', end);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;

  return {
    port,
    pause() {
      paused = true;
    },
    resume() {
      paused = false;
      for (const send of held.splice(0)) send();
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) =>
        server.close(() => {
          resolve();
        }),
      );
    },
  };
}

/** A port nothing listens on: bound, then released. */
export async function closedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>((resolve) =>
    server.close(() => {
      resolve();
    }),
  );
  return port;
}
