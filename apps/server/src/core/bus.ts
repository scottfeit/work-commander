import { EventEmitter } from 'node:events';
import type { ServerEvent } from '@wc/shared';

/** In-process event bus. The SSE endpoint fans these out to connected dashboards. */
class Bus extends EventEmitter {
  publish(e: ServerEvent) {
    this.emit('event', e);
  }
  subscribe(fn: (e: ServerEvent) => void) {
    this.on('event', fn);
    return () => this.off('event', fn);
  }
}

export const bus = new Bus();
bus.setMaxListeners(100);
