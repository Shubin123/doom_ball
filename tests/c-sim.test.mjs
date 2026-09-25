import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { CBoardSimulation } from '../ide/c-sim.js';

async function sourceFor(project) {
  return readFile(new URL(`../firmware/projects/${project}/main.c`, import.meta.url), 'utf8');
}

function runC(source, { target = 'h743', speed = 1, until, onOutput, timeout = 3000 } = {}) {
  return new Promise((resolve, reject) => {
    let sim;
    const state = { output: '', led: false, ledUpdates: 0, lcd: [], hostTx: '', statuses: [] };
    const timer = setTimeout(() => { sim.stop(); reject(new Error('C simulation timed out')); }, timeout);
    const finish = () => { clearTimeout(timer); resolve({ sim, state }); };
    sim = new CBoardSimulation(source, {
      target, speed,
      onOutput: (text) => { state.output += text; onOutput?.(state, sim); if (until?.(state, sim)) { sim.stop(); finish(); } },
      onHostTx: (text) => { state.hostTx += text; },
      onLed: (value) => { state.led = value; state.ledUpdates++; },
      onLcd: (value) => { state.lcd.push(value); if (until?.(state, sim)) { sim.stop(); finish(); } },
      onStatus: (text) => { state.statuses.push(text); if (text.startsWith('Simulation stopped')) { clearTimeout(timer); reject(new Error(text)); } },
    });
    void sim.start().then(finish, (error) => { clearTimeout(timer); reject(error); });
  });
}

test('Blinky executes C printf, HAL_GPIO_TogglePin and the edited HAL_Delay interval', async () => {
  let code = await sourceFor('blinky');
  code = code.replace('blink %lu', 'pulse %lu').replace('HAL_Delay(500)', 'HAL_Delay(125)');
  const started = performance.now();
  const { state } = await runC(code, { speed: 1, until: (s) => s.output.includes('pulse 1') });
  const elapsed = performance.now() - started;
  assert.match(state.output, /STM32 Forge blinky @ 400 MHz/);
  assert.match(state.output, /pulse 0\r\npulse 1/);
  assert.equal(state.led, false, 'two executed GPIO toggles return the LED to its initial state');
  assert.ok(elapsed >= 90 && elapsed < 1500, `edited 125 ms delay elapsed in ${elapsed.toFixed(0)} ms`);
});

test('main calls user-defined C functions instead of reproducing their effects in preview code', async () => {
  let code = await sourceFor('blinky');
  code = code.replace('HAL_GPIO_TogglePin(LED_PORT, LED_PIN);', 'applicationLedToggle();');
  code = `static void applicationLedToggle(void) { HAL_GPIO_TogglePin(LED_PORT, LED_PIN); }\n${code}`;
  const { state } = await runC(code, { speed: 8, until: (s) => s.output.includes('blink 0') });
  assert.equal(state.led, true);
});

test('C preprocessor string and numeric definitions affect simulated output and timing', async () => {
  let code = await sourceFor('blinky');
  code = `#define BOOT_MESSAGE "custom startup @ %lu MHz\\n"\n#define BLINK_PERIOD_MS 125U\n${code}`
    .replace('"STM32 Forge blinky @ %lu MHz\\n"', 'BOOT_MESSAGE')
    .replace('HAL_Delay(500)', 'HAL_Delay(BLINK_PERIOD_MS)');
  const started = performance.now();
  const { state } = await runC(code, { speed: 1, until: (s) => s.output.includes('blink 1') });
  assert.match(state.output, /custom startup @ 400 MHz/);
  assert.ok(performance.now() - started >= 90);
});

test('button example responds to virtual PE4 through the C HAL read and toggle calls', async () => {
  const code = await sourceFor('button-led');
  const result = await runC(code, { speed: 8,
    onOutput: (s, sim) => { if (s.output.includes('press PE4')) sim.pressButton(true); },
    until: (s) => s.output.includes('button press'),
  });
  assert.equal(result.state.led, true);
});

test('UART echo waits for bytes and emits what the C HAL transmit calls produce', async () => {
  const code = await sourceFor('uart-echo');
  const result = await runC(code, { speed: 8,
    onOutput: (s, sim) => { if (s.output.includes('UART echo ready') && !s.hostTx) sim.sendSerial('STM32\r'); },
    until: (s) => s.output.includes('STM32\r\n'),
  });
  assert.match(result.state.output, /UART echo ready \(115200 8N1\)\r\nSTM32\r\n/);
  assert.equal(result.state.hostTx, 'STM32\r');
});

test('timer heartbeat output follows HAL_GetTick and the C scheduling conditions', async () => {
  const code = await sourceFor('timer-blink');
  const { state } = await runC(code, { speed: 8, timeout: 2500, until: (s) => s.output.includes('uptime ') });
  assert.match(state.output, /Timer heartbeat ready\./);
  assert.match(state.output, /uptime \d+ ms/);
  assert.ok(state.ledUpdates >= 4, 'the 250 ms HAL tick schedule toggled the modeled GPIO');
});

test('LCD preview receives the RGB565 values executed from the C color array', async () => {
  let code = await sourceFor('lcd-colors');
  code = code.replace('0xf800', '0x07e0');
  const { state } = await runC(code, { speed: 8, until: (s) => s.lcd.length >= 1 });
  assert.deepEqual(state.lcd, [0x07e0]);
});

test('Blue Pill build branch runs its board C source in the same interpreter', async () => {
  const code = await sourceFor('blinky');
  const { state } = await runC(code, { target: 'bluepill', speed: 8, until: (s) => s.output.includes('blink 0') });
  assert.match(state.output, /STM32 Forge blinky on STM32F103C8T6 Blue Pill @ 72 MHz/);
});
