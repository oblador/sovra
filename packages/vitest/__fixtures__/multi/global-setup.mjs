import { ready } from 'root-helper';
export default function setup() {
  if (!ready) throw new Error('Global setup helper was not ready');
}
