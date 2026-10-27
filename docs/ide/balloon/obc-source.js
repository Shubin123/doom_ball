// Reads the balloon OBC's FreeRTOS tasks, telemetry channels and pin
// assignments out of the uvsd-doom-obc sources, so the diagram shows the
// firmware as it is checked out (and as edited in the IDE).

export const OBC_ROOT = 'uvsd/uvsd-doom-obc';
export const OBC_FILES = {
  main: `${OBC_ROOT}/Core/Src/main.c`,
  sensors: `${OBC_ROOT}/Core/Inc/telemetry_sensors.h`,
  rtos: `${OBC_ROOT}/Core/Inc/FreeRTOSConfig.h`,
  ioc: `${OBC_ROOT}/uvsd-doom-obc.ioc`,
};

const PRIORITY = { tskIDLE_PRIORITY: 0, osPriorityIdle: 1, osPriorityLow: 8, osPriorityBelowNormal: 16, osPriorityNormal: 24, osPriorityAboveNormal: 32, osPriorityHigh: 40, osPriorityRealtime: 48 };
const stripComments = (c) => c.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/.*$/gm, ' ');

export function parseTasks(mainC) {
  const code = stripComments(mainC);
  const tasks = [];
  for (const m of code.matchAll(/osThreadNew\(\s*(\w+)\s*,[^,]*,\s*&(\w+)\s*\)/g)) {
    const attrs = code.match(new RegExp(`${m[2]}\\s*=\\s*\\{([\\s\\S]*?)\\}`))?.[1] || '';
    const field = (name) => attrs.match(new RegExp(`\\.${name}\\s*=\\s*([^,\\n]+)`))?.[1].trim();
    const priority = (field('priority') || '').replace(/\(osPriority_t\)\s*/, '');
    tasks.push({ name: (field('name') || m[1]).replace(/"/g, ''), entry: m[1], api: 'CMSIS-RTOS2 osThreadNew',
      stack: field('stack_size') || '', stackUnit: 1, priority, level: PRIORITY[priority] ?? null });
  }
  for (const m of code.matchAll(/xTaskCreate\(\s*(\w+)\s*,\s*"([^"]*)"\s*,\s*([^,]+?)\s*,\s*[^,]+?\s*,\s*([^,]+?)\s*,/g)) {
    tasks.push({ name: m[2], entry: m[1], api: 'FreeRTOS xTaskCreate', stack: m[3], stackUnit: 4, priority: m[4], level: PRIORITY[m[4]] ?? null });
  }
  return tasks;
}

export function parseTelemetry(header) {
  const channels = [];
  for (const m of header.matchAll(/\/\*\*((?:(?!\*\/)[\s\S])*)\*\/\s*(float|vector3f_t)\s+(read_\w+)\s*\(void\)\s*;/g)) {
    const brief = m[1].match(/@brief\s+([^\n*]+)/)?.[1].trim().replace(/\.$/, '') || m[3];
    const ret = m[1].match(/@return\s+([^\n*]+)/)?.[1] || '';
    const unit = ret.match(/\(([^)]+)\)/)?.[1] || '';
    channels.push({ fn: m[3], brief: brief.replace(/^Reads the\s+/i, ''), unit, vector: m[2] === 'vector3f_t' });
  }
  return channels;
}

// Signal names straight from the CubeMX project, with GPIO labels if any.
export function parsePins(ioc) {
  const pins = new Map();
  for (const m of ioc.matchAll(/^(P[A-K]\d+(?:_C)?)(?:-[^.]+)?\.(Signal|GPIO_Label)=(.+)$/gm)) {
    const pin = pins.get(m[1]) || { pin: m[1] };
    pin[m[2] === 'Signal' ? 'signal' : 'label'] = m[3].trim();
    pins.set(m[1], pin);
  }
  const ips = [...ioc.matchAll(/^Mcu\.IP\d+=(\w+)$/gm)].map((m) => m[1]);
  const mcu = ioc.match(/^Mcu\.UserName=(\S+)/m)?.[1] || ioc.match(/^Mcu\.Name=(\S+)/m)?.[1] || '';
  return { mcu, ips, pins: [...pins.values()].filter((p) => p.signal).sort((a, b) => a.pin.localeCompare(b.pin, 'en', { numeric: true })) };
}

export function parseRtosConfig(header) {
  // e.g. #define configMINIMAL_STACK_SIZE ((uint16_t)128): drop the cast, keep the number.
  const value = (name) => header.match(new RegExp(`^#define\\s+${name}\\s+(.+)$`, 'm'))?.[1]
    .replace(/\(\s*[A-Za-z_]\w*\s*\)/g, '').match(/\d+/)?.[0];
  return { tickHz: Number(value('configTICK_RATE_HZ')), heapBytes: Number(value('configTOTAL_HEAP_SIZE')),
    maxPriorities: Number(value('configMAX_PRIORITIES')), minimalStack: Number(value('configMINIMAL_STACK_SIZE')) };
}

// Stack sizes are written as C expressions ('128 * 4', configMINIMAL_STACK_SIZE);
// xTaskCreate counts words and osThreadNew bytes.
export function stackBytes(task, rtos) {
  const expr = task.stack.replace(/configMINIMAL_STACK_SIZE/g, String(rtos.minimalStack));
  if (!/^[\d\s*+()]+$/.test(expr)) return null;
  return expr.split('*').reduce((product, factor) => product * Number(factor.replace(/[()\s]/g, '')), 1) * task.stackUnit;
}

// Buses grouped by peripheral, e.g. SPI2 -> [PB12 NSS, PB13 SCK, ...].
export function groupPeripherals(pins) {
  const groups = new Map();
  for (const p of pins) {
    const [periph, fn] = p.signal.includes('_') ? [p.signal.split('_')[0], p.signal.split('_').slice(1).join('_')] : [p.signal, ''];
    const key = /^GPIO/.test(periph) ? `GPIO ${fn.toLowerCase() || p.signal}` : periph;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(`${p.pin}${/^GPIO/.test(periph) ? '' : ` ${fn}`}${p.label ? ` (${p.label})` : ''}`);
  }
  return [...groups.entries()].map(([name, list]) => ({ name, pins: list }));
}

export async function readObc(readSource) {
  const [main, sensors, rtos, ioc] = await Promise.all(Object.values(OBC_FILES).map((path) => readSource(path)));
  const pinInfo = parsePins(ioc);
  const config = parseRtosConfig(rtos);
  const tasks = parseTasks(main).map((task) => ({ ...task, stackBytes: stackBytes(task, config) }));
  return { tasks, telemetry: parseTelemetry(sensors), rtos: config, ...pinInfo, peripherals: groupPeripherals(pinInfo.pins) };
}
