import { processMessage } from './worker-utils';

self.onmessage = event => self.postMessage(processMessage(event.data));
