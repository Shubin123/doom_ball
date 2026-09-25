// Small, project-specific hardware previews. These model the example's visible
// behavior in the browser; they do not execute the compiled firmware image.
class ExamplePreview {
  constructor(root) { this.root = root; this.timer = null; }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  show(example) {
    this.stop();
    this.root.hidden = false;
    const id = example?.id || 'blinky';
    const title = example?.name || 'Firmware example';
    const header = `<div class="preview-head"><span>${title}</span><span class="preview-tag">HARDWARE PREVIEW · SIMULATED</span></div>`;
    const board = `<div class="preview-board"><div class="board-label">STM32 ${$('target').value === 'bluepill' ? 'F103 · Blue Pill' : 'H743 · Nucleo'}</div><div class="board-chip">STM32</div><div class="board-led" id="preview-led"><i></i><span>PC13 · LED</span></div><div class="board-pins">PA9 TX · PA10 RX<br>USART1 · 115200 8N1</div></div>`;
    const terminal = `<div class="preview-terminal"><div class="preview-term-title">Example output <span>simulated</span></div><pre id="preview-log" aria-live="polite"></pre></div>`;
    if (id === 'lcd-colors') {
      this.root.innerHTML = `${header}<div class="lcd-preview" id="preview-lcd"><span>ILI9341 · RGB565</span><b id="preview-color-name">RED</b></div><div class="preview-caption">Color cycle · 700 ms · SPI display preview</div>`;
      const colors = [['RED','#ee3038'],['ORANGE','#ff8b25'],['YELLOW','#f6dd35'],['GREEN','#39c76b'],['CYAN','#37c8d0'],['BLUE','#356bea'],['MAGENTA','#d744c7'],['WHITE','#f5f5f2']];
      let n = 0;
      const paint = () => { this.root.querySelector('#preview-lcd').style.setProperty('--lcd-color', colors[n][1]); this.root.querySelector('#preview-color-name').textContent = colors[n][0]; n = (n + 1) % colors.length; };
      paint(); this.timer = setInterval(paint, 700); return;
    }
    if (id === 'uart-echo') {
      this.root.innerHTML = `${header}${board}${terminal}<form class="preview-input" id="preview-form"><input id="preview-send" aria-label="UART text" placeholder="Type a line to send…"><button class="btn primary">Send</button></form><div class="preview-caption">USART1 echo · input is shown as TX, echoed response as RX.</div>`;
      const log = this.root.querySelector('#preview-log');
      this.root.querySelector('#preview-form').addEventListener('submit', (event) => { event.preventDefault(); const input = this.root.querySelector('#preview-send'); const value = input.value; if (!value) return; log.textContent += `TX  ${value}\nRX  ${value}\n`; log.scrollTop = log.scrollHeight; input.value = ''; });
      return;
    }
    this.root.innerHTML = `${header}${board}${terminal}<div class="preview-controls" id="preview-controls"></div><div class="preview-caption" id="preview-caption"></div>`;
    const led = this.root.querySelector('#preview-led');
    const log = this.root.querySelector('#preview-log');
    const controls = this.root.querySelector('#preview-controls');
    const caption = this.root.querySelector('#preview-caption');
    let on = false, count = 0;
    const setLed = (value) => { on = value; led.classList.toggle('on', on); };
    if (id === 'button-led') {
      caption.textContent = 'Press the virtual PE4 button to toggle PC13, matching the active-low board input.';
      controls.innerHTML = '<button class="btn" id="preview-button">PE4 · PRESS</button>';
      controls.querySelector('button').addEventListener('click', () => { setLed(!on); log.textContent += `button press → LED ${on ? 'on' : 'off'}\n`; log.scrollTop = log.scrollHeight; });
      return;
    }
    if (id === 'timer-blink') {
      caption.textContent = 'PC13 pulses every 250 ms; uptime is reported once per second.';
      this.timer = setInterval(() => { setLed(!on); count += 250; if (count % 1000 === 0) { log.textContent += `uptime ${count / 1000}s · LED ${on ? 'on' : 'off'}\n`; log.scrollTop = log.scrollHeight; } }, 250);
      return;
    }
    caption.textContent = 'PC13 blinks every 500 ms; USART1 reports the blink count.';
    this.timer = setInterval(() => { setLed(!on); log.textContent += `blink ${count++} · LED ${on ? 'on' : 'off'}\n`; log.scrollTop = log.scrollHeight; }, 500);
  }

  hide() { this.stop(); this.root.hidden = true; }
}
