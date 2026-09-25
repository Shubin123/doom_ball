// Build the H743 firmware in the browser with a pinned WebAssembly Clang/LLD.
// Compiler assets are lazy-loaded from jsDelivr and cached by the browser.
const TOOLCHAIN = 'https://unpkg.com/microbit-clang-wasm@21.11.0-alpha.1/gen/bundle.js';
const ENGINE = 'engine/doomgeneric/';
const HAL_DIR = 'firmware/third_party/stm32h7xx_hal/Src/';
const HAL_SOURCES = [
  'hal.c','hal_cortex.c','hal_rcc.c','hal_rcc_ex.c','hal_gpio.c','hal_pwr.c',
  'hal_pwr_ex.c','hal_sd.c','hal_sd_ex.c','ll_sdmmc.c','ll_delayblock.c',
  'hal_spi.c','hal_spi_ex.c','hal_uart.c','hal_uart_ex.c','hal_dma.c',
  'hal_dma_ex.c','hal_mdma.c','hal_flash.c','hal_flash_ex.c',
].map((name) => `${HAL_DIR}stm32h7xx_${name}`);
const FIXED_SOURCES = [
  ...HAL_SOURCES,
  'firmware/targets/h743/board.c',
  'firmware/targets/h743/syscalls.c',
  'firmware/targets/h743/dg_stm32.c',
  'firmware/targets/h743/lcd_ili9341.c',
  'firmware/targets/h743/sd_diskio.c',
  'firmware/targets/h743/syscalls_fatfs.c',
  'firmware/third_party/cmsis/device_h7/system_stm32h7xx.c',
  'firmware/third_party/fatfs/ff.c',
  'firmware/third_party/fatfs/ffunicode.c',
];
const INCLUDES = [
  'firmware/targets/h743', 'firmware/third_party/cmsis/core',
  'firmware/third_party/cmsis/device_h7', 'firmware/third_party/stm32h7xx_hal/Inc',
  'firmware/third_party/fatfs', ENGINE.slice(0, -1),
].map((path) => `-I/src/${path}`);
const CPU = ['-mcpu=cortex-m4','-mthumb','-mfpu=fpv4-sp-d16','-mfloat-abi=softfp'];
const DEFINES = [
  '-DSTM32H743xx','-DUSE_HAL_DRIVER','-DCMAP256','-DDG_NO_SCREENBUFFER',
  '-DDG_ZONE_PROVIDER','-DDG_NO_WIPE','-DDG_ZONE_STATIC_TOP','-DDG_STATES_IN_FLASH',
  '-DDOOMGENERIC_RESX=320','-DDOOMGENERIC_RESY=200',
];
let compilerSessionPromise;

function binFromElf(elf) {
  const view = new DataView(elf.buffer, elf.byteOffset, elf.byteLength);
  if (elf[0] !== 0x7f || elf[1] !== 0x45 || elf[2] !== 0x4c || elf[3] !== 0x46 || elf[4] !== 1) {
    throw new Error('Compiler output is not a 32-bit ELF image');
  }
  const phoff = view.getUint32(28, true), phentsize = view.getUint16(42, true), phnum = view.getUint16(44, true);
  const flashStart = 0x08000000, flashEnd = 0x08200000, segments = [];
  for (let i = 0; i < phnum; i++) {
    const p = phoff + i * phentsize;
    if (view.getUint32(p, true) !== 1) continue; // PT_LOAD
    const off = view.getUint32(p + 4, true), addr = view.getUint32(p + 12, true);
    const size = view.getUint32(p + 16, true);
    if (addr >= flashStart && addr + size <= flashEnd && size) segments.push({ off, addr, size });
  }
  if (!segments.length) throw new Error('ELF contains no loadable STM32 flash segment');
  const start = Math.min(...segments.map((s) => s.addr));
  const end = Math.max(...segments.map((s) => s.addr + s.size));
  const image = new Uint8Array(end - start);
  for (const s of segments) image.set(elf.subarray(s.off, s.off + s.size), s.addr - start);
  if (start !== flashStart) throw new Error(`Firmware starts at 0x${start.toString(16)}, expected 0x08000000`);
  return image;
}

function symbolFromElf(elf, target) {
  const view = new DataView(elf.buffer, elf.byteOffset, elf.byteLength);
  const sectionOffset = view.getUint32(32, true), sectionSize = view.getUint16(46, true);
  const sectionCount = view.getUint16(48, true), sections = [];
  for (let i = 0; i < sectionCount; i++) {
    const p = sectionOffset + i * sectionSize;
    sections.push({ type: view.getUint32(p + 4, true), offset: view.getUint32(p + 16, true),
      size: view.getUint32(p + 20, true), link: view.getUint32(p + 24, true), entrySize: view.getUint32(p + 36, true) });
  }
  const decodeName = (table, index) => {
    let end = index;
    while (end < table.length && table[end]) end++;
    return new TextDecoder().decode(table.subarray(index, end));
  };
  for (const section of sections.filter((s) => s.type === 2 && s.entrySize >= 16)) {
    const strings = sections[section.link];
    if (!strings) continue;
    const table = elf.subarray(strings.offset, strings.offset + strings.size);
    for (let p = section.offset; p < section.offset + section.size; p += section.entrySize) {
      const name = decodeName(table, view.getUint32(p, true));
      if (name === target) return view.getUint32(p + 4, true);
    }
  }
  return 0;
}

export async function browserH743Build({ files, source, onLog, toolchainURL = TOOLCHAIN }) {
  const log = (message) => onLog?.(message);
  compilerSessionPromise ||= import(toolchainURL).then((toolchain) => toolchain.createSession());
  const session = await compilerSessionPromise;
  const output = (bytes) => { if (bytes) log(new TextDecoder().decode(bytes).trimEnd()); };
  const headers = files.filter((f) => /\.(h|inc|ld)$/.test(f));
  const paths = [...new Set([
    ...files.filter((f) => f.startsWith(ENGINE) && f.endsWith('.c')),
    ...FIXED_SOURCES,
    'firmware/third_party/cmsis/device_h7/startup_stm32h743xx.s',
  ])];
  log(`Preparing ${paths.length} C/assembly units and current editor buffers…`);
  await Promise.all([...new Set([...paths, ...headers])].map(async (path) => {
    const text = await source(path);
    if (text === null) throw new Error(`Missing build source: ${path}`);
    await session.writeFile(`/src/${path}`, text);
  }));
  // The linker wildcard rules place large DOOM arrays by input object basename.
  const objects = [];
  for (let i = 0; i < paths.length; i++) {
    const path = paths[i], engine = path.startsWith(ENGINE);
    const object = `/out/${path.replaceAll('/', '_').replace(/\.(c|s)$/, '')}.o`;
    const args = ['clang', ...CPU, '--sysroot=/usr', '-O2', '-DSTM32H743xx', '-DUSE_HAL_DRIVER',
      ...INCLUDES, '-ffunction-sections', '-fdata-sections', '-fno-common',
      ...(engine ? [...DEFINES.slice(2), '-std=gnu99', '-w'] : [...DEFINES, '-std=gnu11', '-Wall']),
      ...(path.endsWith('.s') ? ['-x','assembler-with-cpp'] : []), '-c', `/src/${path}`, '-o', object];
    const code = await session.clang(args, { stdout: output, stderr: output });
    if (code !== 0) throw new Error(`Compile failed: ${path}`);
    objects.push(object);
    if ((i + 1) % 10 === 0 || i + 1 === paths.length) log(`Compiled ${i + 1}/${paths.length} units`);
  }
  const linkLog = [];
  const link = await session.clang(['clang', ...CPU, '--sysroot=/usr', '-nostartfiles',
    '-T/src/firmware/targets/h743/h743.ld', '-Wl,--gc-sections', '-Wl,-Map=/out/firmware.map',
    '-Wl,--print-memory-usage', ...objects, '-lm', '-o', '/out/firmware.elf'], {
    stdout: (b) => { if (b) linkLog.push(new TextDecoder().decode(b)); },
    stderr: (b) => { if (b) linkLog.push(new TextDecoder().decode(b)); },
  });
  linkLog.join('').split('\n').filter(Boolean).forEach(log);
  if (link !== 0) throw new Error('H743 link failed. Review the compiler and linker output above.');
  const elf = await session.readFile('/out/firmware.elf');
  const binary = binFromElf(elf);
  const symbol = (name) => symbolFromElf(elf, name);
  const zoneBanks = [['__zone0_start','__zone0_end'],['__zone1_start','__zone1_end'],['__zone2_start','__zone2_end']]
    .map(([a, b]) => symbol(b) - symbol(a));
  return {
    ok: true, binary: (() => {
      let encoded = '';
      for (let i = 0; i < binary.length; i += 0x8000) encoded += String.fromCharCode(...binary.subarray(i, i + 0x8000));
      return btoa(encoded);
    })(), binarySize: binary.length,
    source: 'browser WebAssembly Clang build', zone: zoneBanks.reduce((a, b) => a + b, 0), zoneBanks,
    memory: [...linkLog.join('').matchAll(/^\s*(ITCM|FLASH|DTCM|AXI|SRAM123|SRAM4):\s*(\d+)\s*(B|KB|MB|GB)\s+(\d+)\s*(B|KB|MB|GB)\s+([\d.]+)%\s*$/gm)]
      .map((m) => {
        const bytes = (amount, unit) => Number(amount) * ({ B: 1, KB: 1024, MB: 1048576, GB: 1073741824 }[unit]);
        const used = bytes(m[2], m[3]), size = bytes(m[4], m[5]);
        return { region: m[1], used, size, overflow: Math.max(0, used - size) };
      }),
    log: linkLog.join(''),
  };
}
