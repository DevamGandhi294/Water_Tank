// Reads an ESP board's MAC over USB (Web Serial + esptool-js).
// Works in Chrome / Edge on a laptop, over https or localhost. Nothing is
// written to the board: it is reset into the bootloader, the MAC is read
// from eFuse, then it is reset back into its firmware.

export const usbSupported = () => typeof navigator !== 'undefined' && 'serial' in navigator;

export async function readMacOverUsb(): Promise<string> {
  if (!usbSupported()) throw new Error('USB needs Chrome or Edge on a laptop (Web Serial).');
  let port: SerialPort;
  try {
    port = await navigator.serial.requestPort();
  } catch {
    throw new Error('No USB port chosen');
  }
  const { ESPLoader, Transport } = await import('esptool-js');
  const transport = new Transport(port, false);
  try {
    const loader = new ESPLoader({
      transport,
      baudrate: 115200,
      terminal: { clean() {}, writeLine() {}, write() {} },
    });
    await loader.detectChip('default_reset');
    const mac = (await loader.chip.readMac(loader)).toUpperCase();
    try { await loader.after('hard_reset'); } catch { /* board restarts on unplug anyway */ }
    return mac;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/open|busy|in use/i.test(msg)) throw new Error('The port is busy. Close Arduino IDE / Serial Monitor and try again.');
    throw new Error(`Could not read the board. Hold BOOT, press RESET, then try again. (${msg})`);
  } finally {
    await transport.disconnect().catch(() => undefined);
  }
}
