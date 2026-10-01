// In-page stand-ins for navigator.usb and navigator.serial, for the
// headless-Chrome flashing tests. They behave like Chrome's: getDevices() /
// getPorts() list what the site was allowed before, requestDevice() /
// requestPort() show a picker (here: hand over `picker`, or reject with the
// NotFoundError Chrome raises when the user cancels), and connect /
// disconnect events fire on plug and unplug. Everything the IDE asked for is
// recorded on window.fakes. Listings wait for `fakes.ready`, so a test can
// load its simulated devices asynchronously before the IDE first looks.
const notFound = (what) => Object.assign(new Error(`No ${what} selected.`), { name: 'NotFoundError' });

class FakeUsb extends EventTarget {
  constructor() { super(); this.granted = []; this.picker = null; this.requests = []; }
  async getDevices() { await window.fakes.ready; return [...this.granted]; }
  async requestDevice({ filters }) {
    this.requests.push(filters);
    const dev = this.picker;
    if (!dev || !filters.some((f) => f.vendorId === dev.vendorId && (f.productId === undefined || f.productId === dev.productId))) throw notFound('device');
    if (!this.granted.includes(dev)) this.granted.push(dev);
    return dev;
  }
  plug(dev) { this.granted.push(dev); this.dispatchEvent(Object.assign(new Event('connect'), { device: dev })); }
  unplug(dev) { this.granted = this.granted.filter((d) => d !== dev); this.dispatchEvent(Object.assign(new Event('disconnect'), { device: dev })); }
}

class FakeSerial extends EventTarget {
  constructor() { super(); this.granted = []; this.picker = null; this.requests = 0; }
  async getPorts() { await window.fakes.ready; return [...this.granted]; }
  async requestPort() {
    this.requests++;
    if (!this.picker) throw notFound('port');
    if (!this.granted.includes(this.picker)) this.granted.push(this.picker);
    return this.picker;
  }
}

export function installFakes({ usb = true, serial = true } = {}) {
  const fakes = { usb: usb ? new FakeUsb() : null, serial: serial ? new FakeSerial() : null, ready: Promise.resolve() };
  for (const name of ['usb', 'serial']) {
    if (fakes[name]) Object.defineProperty(navigator, name, { value: fakes[name], configurable: true });
    else { delete Navigator.prototype[name]; delete navigator[name]; }
  }
  window.fakes = fakes;
  return fakes;
}
