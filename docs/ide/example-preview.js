// Presents the STM32 peripheral model driven by CBoardSimulation. The preview
// executes the selected application source in the C interpreter; no example
// timing or serial messages are hard-coded here.
class ExamplePreview {
  constructor(root) { this.root = root; this.sim = null; this.runId = 0; }

  stop() {
    this.runId++;
    if (this.sim) this.sim.stop();
    this.sim = null;
  }

  async show(example, { target, readSource }) {
    this.stop();
    this.root.hidden = false;
    this.root.innerHTML = `<div class="preview-head"><span class="preview-title"></span><span class="preview-tag">C SOURCE SIMULATION</span></div>
      <div class="preview-board"><div class="board-label">STM32 ${target === 'bluepill' ? 'F103 · Blue Pill' : 'H743 · board model'}</div><div class="board-chip">STM32</div>
      <button type="button" class="board-button" id="preview-button" aria-label="Press simulated PE4 button">PE4</button>
      <div class="board-led" id="preview-led"><i></i><span>PC13 · LED</span></div><div class="board-pins">PA9 TX · PA10 RX<br>USART1 · 115200 8N1</div></div>
      <div class="lcd-preview" id="preview-lcd" hidden><span>ILI9341 · RGB565</span><b id="preview-color-name">LCD waiting</b></div>
      <div class="rtos-preview" id="preview-rtos" hidden><div class="rtos-title"><b>FreeRTOS task list</b><span id="rtos-status">waiting for scheduler</span></div><div id="rtos-task-list"></div><div class="rtos-caption">Task state changes are reported by the selected C source simulation.</div></div>
      <div class="preview-terminal"><div class="preview-term-title">USART output / runtime <span id="preview-status">loading C source</span></div><pre id="preview-log" aria-live="polite"></pre></div>
      <form class="preview-input" id="preview-form" hidden><input id="preview-send" aria-label="UART input" placeholder="Send bytes to USART1…"><button class="btn primary" type="submit">Send</button></form>
      <div class="preview-controls"><label>Simulation speed <select id="preview-speed"><option value="0.5">0.5×</option><option value="1" selected>1×</option><option value="2">2×</option><option value="4">4×</option></select></label><button class="btn" id="preview-restart" type="button">Restart C</button></div>
      <div class="preview-caption">Interprets the selected main.c logic against virtual STM32 peripherals. Restart C to reload editor buffers; Build creates the ARM image and Flash verifies it on hardware.</div>`;
    this.root.querySelector('.preview-title').textContent = example?.name || 'Firmware example';
    const log = this.root.querySelector('#preview-log');
    const status = this.root.querySelector('#preview-status');
    const led = this.root.querySelector('#preview-led');
    const lcd = this.root.querySelector('#preview-lcd');
    const sendForm = this.root.querySelector('#preview-form');
    const append = (prefix, text) => { log.textContent += prefix + text; if (log.textContent.length > 12000) log.textContent = log.textContent.slice(-10000); log.scrollTop = log.scrollHeight; };
    const createSimulator = async () => {
      if (this.sim) this.sim.stop();
      this.sim = null;
      const runId = ++this.runId;
      log.textContent = ''; status.textContent = 'loading C source';
      const source = await readSource(example.entry);
      if (runId !== this.runId) return;
      if (typeof source !== 'string') throw new Error(`Could not load ${example.entry}`);
      const targetHeaders = target === 'bluepill'
        ? ['firmware/targets/bluepill/board.h']
        : ['firmware/targets/h743/board.h','firmware/targets/h743/board_config.h'];
      const definitions = await Promise.all(targetHeaders.map((path) => readSource(path)));
      if (runId !== this.runId) return;
      this.sim = new CBoardSimulation(source, {
        target,
        definitions: definitions.filter((header) => typeof header === 'string'),
        onOutput: (text) => append('', text),
        onHostTx: (text) => append('TX  ', text),
        onRtos: (event) => {
          const panel = this.root.querySelector('#preview-rtos');
          const statusLine = this.root.querySelector('#rtos-status');
          const list = this.root.querySelector('#rtos-task-list');
          if (event.type === 'scheduler') statusLine.textContent = `Scheduler ${event.state.toLowerCase()}`;
          if (event.type === 'create') {
            const row = document.createElement('div'); row.className = 'rtos-task'; row.dataset.taskName = event.task.name;
            const name = document.createElement('span'); name.textContent = event.task.name;
            const priority = document.createElement('span'); priority.className = 'rtos-priority'; priority.textContent = `Priority ${event.task.priority}`;
            const state = document.createElement('span'); state.className = 'rtos-state'; state.textContent = event.task.state;
            row.append(name, priority, state); list.appendChild(row);
          }
          if (event.type === 'state') {
            const row = [...list.children].find((item) => item.dataset.taskName === event.name);
            if (row) { row.querySelector('.rtos-state').textContent = event.state; row.classList.toggle('blocked', event.state === 'Blocked'); }
          }
        },
        onLed: (on) => led.classList.toggle('on', on),
        onLcd: (rgb565) => {
          const r = ((rgb565 >> 11) & 31) * 255 / 31, g = ((rgb565 >> 5) & 63) * 255 / 63, b = (rgb565 & 31) * 255 / 31;
          const hex = `#${[r,g,b].map((v) => Math.round(v).toString(16).padStart(2,'0')).join('')}`;
          lcd.hidden = false; lcd.style.setProperty('--lcd-color', hex); this.root.querySelector('#preview-color-name').textContent = `RGB565 0x${rgb565.toString(16).padStart(4,'0').toUpperCase()}`;
        },
        onStatus: (text) => { status.textContent = text; },
      });
      this.sim.setSpeed(this.root.querySelector('#preview-speed').value);
      void this.sim.start();
    };
    this.root.querySelector('#preview-speed').addEventListener('change', (event) => this.sim?.setSpeed(event.target.value));
    this.root.querySelector('#preview-restart').addEventListener('click', () => createSimulator().catch((error) => { status.textContent = error.message; }));
    const button = this.root.querySelector('#preview-button');
    button.addEventListener('pointerdown', () => this.sim?.pressButton(true));
    for (const type of ['pointerup','pointercancel','pointerleave']) button.addEventListener(type, () => this.sim?.pressButton(false));
    button.addEventListener('click', () => { this.sim?.pressButton(true); setTimeout(() => this.sim?.pressButton(false), 120); });
    if (example?.id === 'button-led') button.hidden = false;
    else button.hidden = true;
    if (example?.id === 'uart-echo') sendForm.hidden = false;
    sendForm.addEventListener('submit', (event) => {
      event.preventDefault(); const input = this.root.querySelector('#preview-send');
      if (!input.value) return;
      this.sim?.sendSerial(`${input.value}\r`); input.value = '';
    });
    if (example?.id === 'lcd-colors') {
      lcd.hidden = false;
      this.root.querySelector('.preview-board').hidden = true;
    }
    this.root.querySelector('#preview-rtos').hidden = example?.id !== 'freertos';
    try { await createSimulator(); }
    catch (error) { if (runId === this.runId) status.textContent = `Simulation error: ${error.message}`; }
  }

  hide() { this.stop(); this.root.hidden = true; }
}
