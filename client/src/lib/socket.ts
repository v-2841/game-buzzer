import { io, type Socket } from 'socket.io-client';
import type {
  ClientToServerEvents,
  ServerToClientEvents,
} from '@buzzer/shared';

export type AppSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

// Same-origin connection: dev proxies /socket.io to the Node server, prod
// serves both from one origin.
export function createSocket(): AppSocket {
  return io({ autoConnect: true });
}

/**
 * Clock synchronization (Cristian's algorithm).
 *
 * We estimate how far this device's clock is from the server's. On each ping
 * we measure round-trip time and derive an offset; we keep the offset from the
 * lowest-RTT sample (least network jitter, most accurate). When a player
 * buzzes we add this offset to the local press time so the server can compare
 * everyone on a common timeline regardless of ping.
 */
export class ClockSync {
  /** server_time - local_time, in ms. Add to Date.now() to get server time. */
  private offset = 0;
  private bestRtt = Infinity;

  constructor(private socket: AppSocket) {}

  /** Convert a local timestamp to estimated server time. */
  toServer(localMs: number): number {
    return localMs + this.offset;
  }

  /** Current time on the server's timeline. */
  now(): number {
    return Date.now() + this.offset;
  }

  /** Best (lowest) round-trip time observed so far, in ms. */
  get rtt(): number {
    return Number.isFinite(this.bestRtt) ? this.bestRtt : 0;
  }

  /** Run one calibration round (several samples), keeping the best. */
  async calibrate(samples = 8): Promise<void> {
    for (let i = 0; i < samples; i++) {
      await this.sample();
    }
  }

  /** Re-sample periodically to track clock drift. Returns a cleanup fn. */
  startDriftCorrection(intervalMs = 15000, onSample?: () => void): () => void {
    const id = setInterval(() => void this.sample().then(() => onSample?.()), intervalMs);
    return () => clearInterval(id);
  }

  private sample(): Promise<void> {
    return new Promise((resolve) => {
      const t0 = Date.now();
      // Time out the ping so a dropped packet can't hang calibration forever.
      this.socket.timeout(3000).emit('clock:ping', { t0 }, (err, res) => {
        if (err || !res) {
          resolve();
          return;
        }
        const t1 = Date.now();
        const rtt = t1 - t0;
        if (rtt < this.bestRtt) {
          this.bestRtt = rtt;
          // Assume the reply represents the server's clock at t0 + rtt/2.
          this.offset = res.tServer - (t0 + rtt / 2);
        }
        resolve();
      });
    });
  }
}
