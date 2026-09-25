#!/usr/bin/env python3
"""
Runs the real STM32H743 DOOM firmware (firmware.elf) in a Cortex-M7 CPU
emulator (Unicorn) with enough of the H743 modelled to boot it:

  RCC / PWR / FLASH   ready flags follow their enable bits
  GPIO                BSRR/ODR, buttons read as released
  USART1              TX goes to stdout, RX bytes are injected into the
                      firmware's interrupt ring buffer (no IRQs here)
  SPI1 + ILI9341      the SPI byte stream is decoded (CASET/PASET/RAMWR)
                      into a 320x240 RGB565 framebuffer, saved as PNG
  SDMMC1 + SD card    SDHC card model backed by a FAT image holding
                      DOOM1.WAD, driven by the unmodified ST HAL
  SysTick             HAL_GetTick() advances 1 ms every 16 calls (polling
                      loops call it constantly, so this keeps game time
                      roughly in step with frames)

The game itself - engine, zone allocator across the three RAM banks,
FatFs, newlib syscalls, LCD driver - is the exact code that gets flashed.

usage: h743_emu.py [--elf path] [--wad path] [--frames N] [--png out.png]
                   [--keys "frame:key,..."] [--png-every N]
exit 0 when N frames were drawn and the last one is not blank.
"""
import argparse
import os
import struct
import subprocess
import sys
import tempfile
import time

from elftools.elf.elffile import ELFFile
from unicorn import (Uc, UcError, UC_ARCH_ARM, UC_MODE_THUMB, UC_MODE_MCLASS,
                     UC_HOOK_CODE, UC_HOOK_MEM_UNMAPPED, UC_PROT_ALL)
from unicorn.arm_const import (UC_ARM_REG_PC, UC_ARM_REG_SP, UC_ARM_REG_LR,
                               UC_ARM_REG_R0, UC_CPU_ARM_CORTEX_M7)

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))

RAM_REGIONS = [
    (0x00000000, 64 * 1024),        # ITCM
    (0x08000000, 2048 * 1024),      # FLASH
    (0x1FF00000, 128 * 1024),       # system memory (ROM bootloader, unused)
    (0x20000000, 128 * 1024),       # DTCM
    (0x24000000, 512 * 1024),       # AXI SRAM
    (0x30000000, 288 * 1024),       # SRAM1-3
    (0x38000000, 64 * 1024),        # SRAM4
    (0xE0000000, 1024 * 1024),      # PPB: SCB, NVIC, SysTick (plain RAM)
]
PERIPH_BASE, PERIPH_SIZE = 0x40000000, 0x20000000

RCC = 0x58024400
PWR = 0x58024800
USART1 = 0x40011000
SPI1 = 0x40013000
SDMMC1 = 0x52007000
GPIO_BASE = 0x58020000          # GPIOA, +0x400 per port


# --------------------------------------------------------------------------
# SD card (SDHC, block addressed) behind the SDMMC register interface
# --------------------------------------------------------------------------
class SdCard:
    # STA bits
    CCRCFAIL, CTIMEOUT, CMDREND, CMDSENT = 1 << 0, 1 << 2, 1 << 6, 1 << 7
    DATAEND, DBCKEND, DPSMACT = 1 << 8, 1 << 10, 1 << 12
    TXFIFOHE, RXFIFOHF, RXFIFOE, BUSYD0END = 1 << 14, 1 << 15, 1 << 19, 1 << 21

    def __init__(self, image):
        self.img = bytearray(open(image, 'rb').read())
        self.blocks = len(self.img) // 512
        self.regs = {}
        self.sta = 0
        self.resp = [0, 0, 0, 0]
        self.respcmd = 0
        self.app_cmd = False
        self.rca = 0x1234
        self.rx = b''          # pending read data
        self.rx_pos = 0
        self.tx_addr = None    # pending write
        self.tx_buf = bytearray()
        self.tx_len = 0
        self.reads = 0

    def _csd_v2(self):
        c_size = self.blocks // 1024 - 1
        csd = 0
        csd |= 1 << 126                     # CSD_STRUCTURE = 1 (v2)
        csd |= 0x0E << 112                  # TAAC
        csd |= 0x32 << 96                   # TRAN_SPEED 25 MHz
        csd |= 0x5B5 << 84                  # CCC
        csd |= 9 << 80                      # READ_BL_LEN 512
        csd |= (c_size & 0x3FFFFF) << 48
        csd |= 1 << 46                      # ERASE_BLK_EN
        csd |= 0x7F << 39                   # SECTOR_SIZE
        csd |= 2 << 26                      # R2W_FACTOR
        csd |= 9 << 22                      # WRITE_BL_LEN
        csd |= 1                            # always 1 (CRC placeholder)
        return csd

    def _set_r2(self, value128):
        self.resp = [(value128 >> 96) & 0xFFFFFFFF, (value128 >> 64) & 0xFFFFFFFF,
                     (value128 >> 32) & 0xFFFFFFFF, value128 & 0xFFFFFFFF]

    def _start_read(self, data):
        self.rx = bytes(data)
        self.rx_pos = 0

    def command(self, cmd, arg):
        app = self.app_cmd
        self.app_cmd = False
        r1 = (4 << 9) | (1 << 8)            # state TRAN, READY_FOR_DATA
        self.respcmd = cmd
        ok = self.CMDREND
        if cmd == 0:
            self.sta |= self.CMDSENT
            return
        if cmd == 8:
            self.resp[0] = arg & 0xFFF
        elif cmd == 55:
            self.app_cmd = True
            self.resp[0] = r1 | (1 << 5)
        elif cmd == 41 and app:
            self.resp[0] = 0xC0FF8000        # ready, CCS (SDHC), 2.7-3.6 V
        elif cmd == 2:
            self._set_r2(0x035344534430303010ABCDEF00012300)  # CID
        elif cmd == 3:
            self.resp[0] = (self.rca << 16) | 0x0500
        elif cmd == 9:
            self._set_r2(self._csd_v2())
        elif cmd == 51 and app:              # SCR: SD 2.0, 1+4-bit bus
            self.resp[0] = r1
            self._start_read(struct.pack('>II', 0x02358000, 0))
        elif cmd == 13 and app:              # SD status, 64 bytes
            self.resp[0] = r1
            self._start_read(bytes(64))
        elif cmd == 6 and app:               # bus width
            self.resp[0] = r1
        elif cmd == 17 or cmd == 18:
            self.resp[0] = r1
            dlen = self.regs.get(0x28, 512)
            start = arg * 512
            self._start_read(self.img[start:start + dlen])
            self.reads += 1
        elif cmd == 24 or cmd == 25:
            self.resp[0] = r1
            self.tx_addr = arg * 512
            self.tx_len = self.regs.get(0x28, 512)
            self.tx_buf = bytearray()
        else:                                # 7, 12, 13, 16, ... : plain R1
            self.resp[0] = r1
        self.sta |= ok

    def read(self, off):
        if off == 0x34:                      # STA
            sta = self.sta
            if self.rx:
                remaining = len(self.rx) - self.rx_pos
                if remaining >= 32:
                    sta |= self.RXFIFOHF
                if remaining > 0:
                    sta |= self.DPSMACT
                else:
                    sta |= self.RXFIFOE | self.DATAEND | self.DBCKEND
            if self.tx_addr is not None:
                if len(self.tx_buf) < self.tx_len:
                    sta |= self.TXFIFOHE | self.DPSMACT
                else:
                    sta |= self.DATAEND | self.DBCKEND
            return sta
        if off == 0x10:
            return self.respcmd
        if 0x14 <= off <= 0x20:
            return self.resp[(off - 0x14) // 4]
        if off == 0x80:                      # FIFO
            if self.rx and self.rx_pos < len(self.rx):
                word = self.rx[self.rx_pos:self.rx_pos + 4].ljust(4, b'\0')
                self.rx_pos += 4
                return struct.unpack('<I', word)[0]
            return 0
        return self.regs.get(off, 0)

    def write(self, off, value):
        self.regs[off] = value
        if off == 0x0C and value & (1 << 12):        # CMD with CPSMEN
            self.command(value & 0x3F, self.regs.get(0x08, 0))
        elif off == 0x38:                            # ICR
            self.sta &= ~value
            if value & self.DATAEND:
                self.rx = b''
                self._finish_write()
        elif off == 0x80 and self.tx_addr is not None:
            self.tx_buf += struct.pack('<I', value & 0xFFFFFFFF)

    def _finish_write(self):
        if self.tx_addr is not None and len(self.tx_buf) >= self.tx_len:
            self.img[self.tx_addr:self.tx_addr + self.tx_len] = self.tx_buf[:self.tx_len]
        self.tx_addr = None


# --------------------------------------------------------------------------
# ILI9341 fed from SPI1 TXDR writes; D/C and CS come from GPIO ODR
# --------------------------------------------------------------------------
class Ili9341:
    def __init__(self):
        self.fb = bytearray(320 * 240 * 2)
        self.cmd = None
        self.args = bytearray()
        self.x0 = self.x1 = self.y0 = self.y1 = 0
        self.x = self.y = 0
        self.pix = bytearray()
        self.frames = 0

    def byte(self, b, dc):
        if not dc:
            self.cmd = b
            self.args = bytearray()
            if b == 0x2C:
                self.x, self.y = self.x0, self.y0
                self.pix = bytearray()
            return
        if self.cmd == 0x2C:
            self.pix.append(b)
            if len(self.pix) == 2:
                if self.x < 320 and self.y < 240:
                    i = (self.y * 320 + self.x) * 2
                    self.fb[i] = self.pix[0]
                    self.fb[i + 1] = self.pix[1]
                self.pix = bytearray()
                self.x += 1
                if self.x > self.x1:
                    self.x = self.x0
                    self.y += 1
                    if self.y > self.y1:
                        self.y = self.y0
                        if self.y1 - self.y0 + 1 == 200:
                            self.frames += 1
            return
        self.args.append(b)
        if len(self.args) == 4 and self.cmd in (0x2A, 0x2B):
            a, e = (self.args[0] << 8) | self.args[1], (self.args[2] << 8) | self.args[3]
            if self.cmd == 0x2A:
                self.x0, self.x1 = a, e
            else:
                self.y0, self.y1 = a, e

    def save_png(self, path):
        from PIL import Image
        img = Image.new('RGB', (320, 240))
        px = img.load()
        for y in range(240):
            for x in range(320):
                i = (y * 320 + x) * 2
                c = (self.fb[i] << 8) | self.fb[i + 1]
                px[x, y] = (((c >> 11) & 0x1F) << 3, ((c >> 5) & 0x3F) << 2, (c & 0x1F) << 3)
        img.save(path)

    def distinct_colours(self):
        return len({bytes(self.fb[i:i + 2]) for i in range(20 * 640, 220 * 640, 2)})


# --------------------------------------------------------------------------
class H743:
    def __init__(self, elf_path, sd_image, keys):
        self.uc = Uc(UC_ARCH_ARM, UC_MODE_THUMB | UC_MODE_MCLASS)
        self.uc.ctl_set_cpu_model(UC_CPU_ARM_CORTEX_M7)
        for base, size in RAM_REGIONS:
            self.uc.mem_map(base, size, UC_PROT_ALL)
        self.uc.mmio_map(PERIPH_BASE, PERIPH_SIZE, self._mmio_read, None,
                         self._mmio_write, None)
        self.regs = {}
        self.sd = SdCard(sd_image)
        self.lcd = Ili9341()
        self.uart_out = bytearray()
        self.keys = sorted(keys, key=lambda k: k[0])   # (frame, byte), stable: keeps F0/F1 before the key
        self.tick_calls = 0
        self.tick = 0
        self.png_every = 0
        self.png_prefix = None
        self.stop_reason = None
        self.target_frames = 0

        with open(elf_path, 'rb') as f:
            elf = ELFFile(f)
            for seg in elf.iter_segments():
                if seg['p_type'] != 'PT_LOAD' or not seg['p_filesz']:
                    continue
                self.uc.mem_write(seg['p_paddr'], seg.data())
            self.sym = {s.name: s['st_value'] for s in elf.get_section_by_name('.symtab').iter_symbols()
                        if s.name}
        # Startup copies .data from its flash load address; nothing else needed.
        vec = struct.unpack('<II', self.uc.mem_read(0x08000000, 8))
        self.uc.reg_write(UC_ARM_REG_SP, vec[0])
        self.entry = vec[1]

        def at(name):
            return self.sym[name] & ~1

        self.uc.hook_add(UC_HOOK_CODE, self._on_get_tick, begin=at('HAL_GetTick'), end=at('HAL_GetTick'))
        self.uc.hook_add(UC_HOOK_CODE, self._on_panic, begin=at('board_panic'), end=at('board_panic'))
        self.uc.hook_add(UC_HOOK_CODE, self._on_frame, begin=at('DG_DrawFrame'), end=at('DG_DrawFrame'))
        self.uc.hook_add(UC_HOOK_MEM_UNMAPPED, self._on_unmapped)

    # --- CPU hooks ---
    def _on_get_tick(self, uc, addr, size, _):
        self.tick_calls += 1
        self.tick = self.tick_calls // 16
        uc.mem_write(self.sym['uwTick'], struct.pack('<I', self.tick))

    def _inject_rx(self, byte):
        head = self.uc.mem_read(self.sym['rx_head'], 1)[0]
        self.uc.mem_write(self.sym['rx_buf'] + head, bytes([byte]))
        self.uc.mem_write(self.sym['rx_head'], bytes([(head + 1) & 0xFF]))

    def _on_panic(self, uc, addr, size, _):
        msg = uc.mem_read(uc.reg_read(UC_ARM_REG_R0), 96).split(b'\0')[0].decode(errors='replace')
        self.stop_reason = 'panic: ' + msg
        uc.emu_stop()

    def _on_frame(self, uc, addr, size, _):
        frame = self.lcd.frames
        while self.keys and self.keys[0][0] <= frame:
            self._inject_rx(self.keys.pop(0)[1])
        if self.png_every and frame and frame % self.png_every == 0:
            self.lcd.save_png('%s%04d.png' % (self.png_prefix, frame))
        if self.target_frames and frame >= self.target_frames:
            self.stop_reason = 'frames'
            uc.emu_stop()

    def _on_unmapped(self, uc, access, addr, size, value, _):
        self.stop_reason = 'unmapped access at 0x%08x (pc 0x%08x)' % (addr, uc.reg_read(UC_ARM_REG_PC))
        return False

    # --- peripherals ---
    def _mmio_read(self, uc, offset, size, _):
        addr = PERIPH_BASE + offset
        if SDMMC1 <= addr < SDMMC1 + 0x400:
            return self.sd.read(addr - SDMMC1)
        if addr == RCC:                                  # CR: RDY bits follow ON bits
            cr = self.regs.get(addr, 0x3)
            rdy = 0x4 | (1 << 5) | (1 << 14) | (1 << 15)  # HSIRDY HSIDIVF D1/D2CKRDY
            for on, r in ((7, 8), (12, 13), (16, 17), (24, 25), (26, 27), (28, 29)):
                if cr & (1 << on):
                    rdy |= 1 << r
            return cr | rdy
        if addr == RCC + 0x10:                           # CFGR: SWS mirrors SW
            v = self.regs.get(addr, 0)
            return (v & ~0x38) | ((v & 7) << 3)
        if addr in (PWR + 0x04, PWR + 0x18):             # CSR1.ACTVOSRDY, D3CR.VOSRDY
            return self.regs.get(addr, 0) | (1 << 13)
        if addr == USART1 + 0x1C:                        # ISR: TXE TC TEACK REACK
            return (1 << 7) | (1 << 6) | (1 << 21) | (1 << 22)
        if addr == SPI1 + 0x14:                          # SR: TXP EOT TXTF TXC
            return (1 << 1) | (1 << 3) | (1 << 4) | (1 << 12)
        if GPIO_BASE <= addr < GPIO_BASE + 0x2C00 and (addr & 0x3FF) == 0x10:
            return 0xFFFF                                # IDR: buttons released
        return self.regs.get(addr, 0)

    def _mmio_write(self, uc, offset, size, value, _):
        addr = PERIPH_BASE + offset
        if SDMMC1 <= addr < SDMMC1 + 0x400:
            self.sd.write(addr - SDMMC1, value)
            return
        if addr == USART1 + 0x28:                        # TDR
            self.uart_out.append(value & 0xFF)
            sys.stdout.write(chr(value & 0xFF))
            sys.stdout.flush()
            return
        if addr == SPI1 + 0x20:                          # TXDR (8- or 32-bit writes)
            dc = bool(self.regs.get(GPIO_BASE + 0x400 + 0x14, 0) & (1 << 1))   # PB1
            for i in range(size):
                self.lcd.byte((value >> (8 * i)) & 0xFF, dc)
            return
        if GPIO_BASE <= addr < GPIO_BASE + 0x2C00 and (addr & 0x3FF) == 0x18:   # BSRR
            odr_addr = addr - 0x18 + 0x14
            odr = self.regs.get(odr_addr, 0)
            odr = (odr | (value & 0xFFFF)) & ~((value >> 16) & 0xFFFF)
            self.regs[odr_addr] = odr
            return
        self.regs[addr] = value

    def run(self, frames, timeout_s):
        self.target_frames = frames
        start = time.time()
        try:
            self.uc.emu_start(self.entry | 1, 0xFFFFFFFF, timeout=int(timeout_s * 1e6))
        except UcError as e:
            if not self.stop_reason:
                self.stop_reason = 'cpu error %s at pc 0x%08x' % (e, self.uc.reg_read(UC_ARM_REG_PC))
        if not self.stop_reason:
            pc = self.uc.reg_read(UC_ARM_REG_PC)
            self.stop_reason = 'timeout at pc 0x%08x (%s)' % (pc, self.symbolize(pc))
        return time.time() - start

    def symbolize(self, pc):
        best = None
        for name, a in self.sym.items():
            a &= ~1
            if a <= pc and (best is None or a > best[1]):
                best = (name, a)
        return '%s+0x%x' % (best[0], pc - best[1]) if best else '?'


def make_sd_image(wad, path):
    subprocess.run(['mkfs.fat', '-C', '-F', '32', '-S', '512', path, str(64 * 1024)],
                   check=True, stdout=subprocess.DEVNULL)
    subprocess.run(['mcopy', '-i', path, wad, '::DOOM1.WAD'], check=True)


def parse_keys(spec):
    """"5:enter,8:enter" -> [(frame, byte), ...] using the F0/F1 key protocol;
    a key is held for 3 frames. "20-60:up" holds up from frame 20 to 60."""
    names = {'enter': 13, 'esc': 27, 'up': 0xAD, 'down': 0xAF, 'left': 0xAC,
             'right': 0xAE, 'fire': 0xA3, 'use': 0xA2}
    out = []
    for item in filter(None, spec.split(',')):
        t, k = item.split(':')
        key = names.get(k, ord(k[0]) if len(k) == 1 else None)
        start, _, end = t.partition('-')
        start = int(start)
        end = int(end) if end else start + 3
        out += [(start, 0xF0), (start, key), (end, 0xF1), (end, key)]
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--elf', default=os.path.join(ROOT, 'firmware/build/h743-doom/firmware.elf'))
    ap.add_argument('--wad', default=os.path.join(ROOT, 'sim/doom1.wad'))
    ap.add_argument('--frames', type=int, default=3)
    ap.add_argument('--png', default=None)
    ap.add_argument('--keys', default='')
    ap.add_argument('--timeout', type=float, default=600)
    ap.add_argument('--png-every', type=int, default=0)
    args = ap.parse_args()

    with tempfile.TemporaryDirectory() as tmp:
        img = os.path.join(tmp, 'sd.img')
        make_sd_image(args.wad, img)
        emu = H743(args.elf, img, parse_keys(args.keys))
        if args.png_every and args.png:
            emu.png_every = args.png_every
            emu.png_prefix = args.png[:-4] + '_'
        secs = emu.run(args.frames, args.timeout)

    colours = emu.lcd.distinct_colours()
    print('\n--- emulator: %s after %.1fs, %d frames drawn, %d ms of firmware time, '
          '%d SD reads, %d colours in last frame'
          % (emu.stop_reason, secs, emu.lcd.frames, emu.tick, emu.sd.reads, colours))
    if args.png:
        emu.lcd.save_png(args.png)
        print('--- framebuffer saved to', args.png)
    ok = emu.stop_reason == 'frames' and colours >= 16
    sys.exit(0 if ok else 1)


if __name__ == '__main__':
    main()
