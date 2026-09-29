// From the stipple tool (pipeline/separation/lut.ts).
// A MessageChannel round-trip queues a macrotask, so a pending 'message' event
// (for example a newer request) gets a chance to run before long work resumes,
// without setTimeout(0)'s minimum-delay throttling.
const yieldChannel = new MessageChannel();

export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    yieldChannel.port1.onmessage = () => resolve();
    yieldChannel.port2.postMessage(null);
  });
}
