// The DOOM balloon as built in the UVic Satellite Design repositories: boards,
// their main parts and the links between them. Facts come from the Altium
// schematics and the firmware sources under uvsd/; links the designs don't
// define yet carry `planned: true` and say what they are based on.

export const BLOCKS = [
  {
    id: 'nrf', segment: 'flight', title: 'DOOM payload', subtitle: 'nRF5340 DK', repo: 'uvsd-nrf-doom', hw: 'uvsd-doom-nrf-pcb',
    parts: ['nRF5340-QKAA: Cortex-M33 application core + network core', 'MX25R6435F 64 Mbit QSPI flash (DOOM1.WAD)', 'On-board debugger with USB virtual COM ports'],
    does: 'Runs DOOM and streams each 320×200 frame as an 8-bit palette-indexed RLE packet (n_frame_uart.c): SYNC AA 55, TYPE, LENGTH, PLAYPAL, RLE, CRC-16/CCITT-FALSE. The stream currently leaves on UART at 115200 baud.',
    status: 'DOOM runs on the DK; frame streaming is on the video-output-streaming branch (PR #12).',
  },
  {
    id: 'pico', segment: 'flight', title: 'Pico bridge', subtitle: 'RP2350 · Pico 2', repo: 'uvsd-pico-bridge',
    parts: ['SPI slave on GPIO16–19 (SPI0), 1 MHz, mode 0 planned', 'USB CDC serial to a laptop'],
    does: 'Bench bridge from the payload to a laptop: the firmware sends a JPEG (header line, 3072-byte chunks, \\n__IMAGE_EOF__\\n) and the Python receiver writes it to a file.',
    status: 'USB transfer works (sample frame built in); SPI input from the nRF is still commented out.',
  },
  {
    id: 'obc', segment: 'flight', title: 'On-board computer', subtitle: 'STM32H733VGT6', repo: 'uvsd-doom-obc', hw: 'uvsd-doom-obc-pcb-v2',
    parts: ['STM32H733VGT6 Cortex-M7, 50 MHz + 32.768 kHz crystals', 'MS5611 altimeter, KX134 accelerometer, I3G4250D gyro on I2C4 (PD12/PD13)', 'MCP9700A temperature sensor on PC2_C', 'MT29F4G01 4 Gb SPI-NAND on SPI2, microSD on SDMMC1', 'J7: parachute release 1/2 (PA12/PA11), antenna release (PD7); J8: switches (PD3/PD4)'],
    does: 'FreeRTOS firmware: telemetry, command handling and SD logging tasks, and the burnwire cut-down.',
    status: 'Tasks, sensor getters, SD and command APIs exist as stubs; burnwire timing is in draft PR #33.',
  },
  {
    id: 'ttc', segment: 'flight', title: 'TT&C radio', subtitle: 'CC1201 · 915 MHz ISM', repo: null, hw: 'uvsd-doom-ttc-pcb',
    parts: ['TI CC1201 sub-GHz transceiver, 40 MHz crystal', 'TX: PE4259 switch → attenuator → GRF5511 PA → low-pass → PE4259', 'RX: PE4259 → B39921 SAW filter → TQP3M9036 LNA → PE4259', 'MCX antenna jack, four U.FL RF test ports', 'u-blox MAX-M8C GPS, two TMP112 temperature sensors'],
    does: 'Half-duplex radio for the downlink and command uplink. CC1201 GPIO3 flips both RF switches and enables the PA; GPIO2 enables the LNA; GPIO0 interrupts the OBC.',
    status: 'Board designed (4 layers, 90×95 mm); the 915 MHz band is inferred from the SAW filter and CC1201 matching.',
  },
  {
    id: 'eps', segment: 'flight', title: 'Power system', subtitle: '1S2P Li-ion', repo: null, hw: 'uvsd-doom-eps-pcb',
    parts: ['2 × NCR18650GA in parallel, BQ298216 protector + TPS259530 eFuse per cell', 'TPS63020 → 3V3 2 A for OBC, nRF and TTC', 'TPS63020 → 5V 2 A (ORCA TTC)', 'TPS61088 → 7V7 burnwire', 'INA214 current sense + dividers per rail, TMP235 per regulator, two TLA2528 I2C ADCs'],
    does: 'Powers every board and reports rail currents, voltages and regulator temperatures to the OBC over I2C.',
    status: 'Schematics drawn; the PCB layout is not started.',
  },
  {
    id: 'sdr', segment: 'ground', title: 'SDR receiver', subtitle: 'RTL-SDR · GNU Radio', repo: 'uvsd-doom-gnu-radio',
    parts: ['RTL-SDR dongle on the 915 MHz band', 'GNU Radio Companion flowgraph DOOMflow.grc', 'Recorded gameplay: doom_raw.bin, doom_raw_rgb.bin, doom_gameplay.cfile (IQ)'],
    does: 'Demodulates the video downlink and hands frames to the viewer over ZMQ.',
    status: 'Flowgraph and viewers run against the recorded gameplay; over-the-air reception is next.',
  },
  {
    id: 'gs', segment: 'ground', title: 'Ground station', subtitle: 'PyQt6 app', repo: 'uvsd-doom-gs',
    parts: ['Palette-indexed 320×200 DOOM display (assets/palettes.hex)', 'Keyboard recorder at 30 Hz, USB HID usage codes', 'Telemetry and command pages (branches)'],
    does: 'Shows the downlinked game and builds keyboard uplink commands: [0x02][batch][seq][count][N][N × modifiers,k1,k2,k3], then [0x04][batch].',
    status: 'Display, palettes and packet building on main with CI; the serial frame receiver is PR #10; packets are not sent yet.',
  },
];

export const LINKS = [
  { from: 'eps', to: 'obc', kind: 'power', label: '3V3 2 A', note: 'EPS 3V3_2A_OBC into OBC J2.' },
  { from: 'eps', to: 'nrf', kind: 'power', label: '3V3 2 A', note: 'EPS 3V3_2A_NRF.' },
  { from: 'eps', to: 'ttc', kind: 'power', label: '3V3 2 A', note: 'EPS 3V3_2A_SLIPTTC into TTC V_IN.' },
  { from: 'eps', to: 'obc', kind: 'bus', label: 'I2C ADCs', note: 'TLA2528 at 0x10 and 0x14; the OBC pins are not assigned yet.', planned: true },
  { from: 'obc', to: 'ttc', kind: 'bus', label: 'SPI + IRQ', note: 'CC1201 SPI and GPIO0 interrupt; the first OBC revision used SPI4 (PE11–14) over a 2×7 header that later revisions removed.', planned: true },
  { from: 'nrf', to: 'obc', kind: 'data', label: 'frames', note: 'DOOM frame packets; carried on UART today, SPI planned. No OBC pins are assigned yet.', planned: true },
  { from: 'nrf', to: 'pico', kind: 'data', label: 'SPI', note: 'Bench path: nRF SPI master to the Pico\'s SPI slave.', planned: true },
  { from: 'ttc', to: 'sdr', kind: 'rf', label: '915 MHz downlink', note: 'Video frames to the ground.' },
  { from: 'gs', to: 'ttc', kind: 'rf', label: 'uplink', note: 'Keyboard and control commands to the balloon.', planned: true },
  { from: 'sdr', to: 'gs', kind: 'data', label: 'ZMQ / serial', note: 'Demodulated frames to the display.' },
];

// The ground station's command list (ground-station-command-page branch).
export const UPLINK_COMMANDS = {
  0x01: 'Ping', 0x02: 'DOOM keyboard', 0x03: 'DOOM gamepad', 0x04: 'DOOM EOF', 0x05: 'Request telemetry',
  0x06: 'Burn wire', 0x07: 'Play DOOM', 0x08: 'Reset buffer', 0x09: 'Reset DOOM', 0x0a: 'ACK',
  0x0b: 'NACK image', 0x0c: 'Frame received', 0x0d: 'Request game state', 0x0e: 'NACK game state', 0x0f: 'Game state received',
};

// Burnwire rule from PR #33 (draft): fire at 23,100 m or after 55 minutes,
// or on the ground's command.
export const BURNWIRE = { altitudeM: 23100, timeS: 55 * 60, pin: 'PA11 PARA_BRN_1', rail: '7V7 burnwire boost' };
