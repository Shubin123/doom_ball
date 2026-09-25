/*
 * STM32H743IITx linker script for the DOOM port.
 *
 * DOOM needs ~700 KB of zone heap plus ~250 KB of static data, more than
 * any single SRAM bank, so memory is spread across every bank:
 *
 *   FLASH    2 MB   code, read-only data, the DOOM state table
 *   ITCM    64 KB   large render arrays (openings, viewangletox)
 *   DTCM   128 KB   .data, .bss, malloc heap, stack, zone (part 0)
 *   AXI    512 KB   visplanes, zone (part 1)
 *   SRAM123 288 KB  zone (part 2)
 *   SRAM4   64 KB   FatFs objects, LCD line buffers, other render arrays
 *
 * The zone parts are joined into one heap by DG_ZoneGap()/Z_ReserveGap().
 */
ENTRY(Reset_Handler)

MEMORY
{
  ITCM    (xrw) : ORIGIN = 0x00000000, LENGTH = 64K
  FLASH   (rx)  : ORIGIN = 0x08000000, LENGTH = 2048K
  DTCM    (xrw) : ORIGIN = 0x20000000, LENGTH = 128K
  AXI     (xrw) : ORIGIN = 0x24000000, LENGTH = 512K
  SRAM123 (xrw) : ORIGIN = 0x30000000, LENGTH = 288K
  SRAM4   (xrw) : ORIGIN = 0x38000000, LENGTH = 64K
}

_Min_Stack_Size = 0x4000;   /* 16 KB */
_Heap_Size      = 0xC000;   /* 48 KB newlib malloc (WAD directory, stdio) */
_Min_Zone0_Size = 0x2000;   /* DTCM left for the zone must be at least this */
_Min_Zone_Size  = 704K;     /* smallest zone that ran every demo in tests/sim_headless */

SECTIONS
{
  .isr_vector :
  {
    . = ALIGN(4);
    KEEP(*(.isr_vector))
    . = ALIGN(4);
  } >FLASH

  .text :
  {
    . = ALIGN(4);
    *(.text)
    *(.text*)
    *(.glue_7)
    *(.glue_7t)
    *(.eh_frame)
    KEEP (*(.init))
    KEEP (*(.fini))
    . = ALIGN(4);
    _etext = .;
  } >FLASH

  .rodata :
  {
    . = ALIGN(4);
    *(.rodata)
    *(.rodata*)
    . = ALIGN(4);
  } >FLASH

  .ARM.extab : { *(.ARM.extab* .gnu.linkonce.armextab.*) } >FLASH
  .ARM : {
    __exidx_start = .;
    *(.ARM.exidx*)
    __exidx_end = .;
  } >FLASH

  .preinit_array :
  {
    PROVIDE_HIDDEN (__preinit_array_start = .);
    KEEP (*(.preinit_array*))
    PROVIDE_HIDDEN (__preinit_array_end = .);
  } >FLASH
  .init_array :
  {
    PROVIDE_HIDDEN (__init_array_start = .);
    KEEP (*(SORT(.init_array.*)))
    KEEP (*(.init_array*))
    PROVIDE_HIDDEN (__init_array_end = .);
  } >FLASH
  .fini_array :
  {
    PROVIDE_HIDDEN (__fini_array_start = .);
    KEEP (*(SORT(.fini_array.*)))
    KEEP (*(.fini_array*))
    PROVIDE_HIDDEN (__fini_array_end = .);
  } >FLASH

  /* Placed before .bss so these specific input sections match here first. */
  /* Render arrays in ITCM. Starts at 0x400 so no object sits at NULL. */
  .itcm_bss 0x400 (NOLOAD) :
  {
    __itcm_bss_start = .;
    *r_plane.o(.bss.openings)
    *r_main.o(.bss.viewangletox)
    . = ALIGN(4);
    __itcm_bss_end = .;
  } >ITCM

  .sram4 (NOLOAD) :
  {
    . = ALIGN(4);
    __sram4_start = .;
    *(.sram4)
    *(.sram4*)
    *d_loop.o(.bss.ticdata)
    *r_bsp.o(.bss.drawsegs)
    *r_main.o(.bss.zlight)
    *r_things.o(.bss.vissprites)
    *r_draw.o(.bss.columnofs .bss.ylookup)
    . = ALIGN(4);
    __sram4_end = .;
  } >SRAM4

  .axi_bss (NOLOAD) :
  {
    __axi_bss_start = .;
    *r_plane.o(.bss.visplanes)
    *r_*.o(.bss .bss.*)
    *statdump.o(.bss .bss.*)
    . = ALIGN(8);
    __axi_bss_end = .;
  } >AXI

  _sidata = LOADADDR(.data);

  .data :
  {
    . = ALIGN(4);
    _sdata = .;
    *(.data)
    *(.data*)
    . = ALIGN(4);
    _edata = .;
  } >DTCM AT> FLASH

  .bss (NOLOAD) :
  {
    . = ALIGN(4);
    _sbss = .;
    __bss_start__ = _sbss;
    *(.bss)
    *(.bss*)
    *(COMMON)
    . = ALIGN(4);
    _ebss = .;
    __bss_end__ = _ebss;
  } >DTCM

  /* Fixed malloc heap and stack; whatever DTCM is left joins the zone. */
  .heap (NOLOAD) :
  {
    . = ALIGN(8);
    PROVIDE ( end = . );
    PROVIDE ( _end = . );
    __heap_start = .;
    . = . + _Heap_Size;
    __heap_end = .;
  } >DTCM

  .stack (NOLOAD) :
  {
    . = ALIGN(8);
    . = . + _Min_Stack_Size;
    . = ALIGN(8);
    _estack = .;
  } >DTCM

  ASSERT(__zone0_end - __zone0_start >= _Min_Zone0_Size, "DTCM: no room left for the zone")

  /*
   * DOOM zone heap: all RAM not used above, in three banks. These are plain
   * symbols rather than sections so the memory usage report shows the real
   * static footprint; the zone size is checked here instead.
   */
  __zone0_start = ALIGN(_estack, 8);
  __zone0_end   = ORIGIN(DTCM) + LENGTH(DTCM);
  __zone1_start = ALIGN(__axi_bss_end, 8);
  __zone1_end   = ORIGIN(AXI) + LENGTH(AXI);
  __zone2_start = ORIGIN(SRAM123);
  __zone2_end   = ORIGIN(SRAM123) + LENGTH(SRAM123);
  __zone_total  = (__zone0_end - __zone0_start) + (__zone1_end - __zone1_start) +
                  (__zone2_end - __zone2_start);

  ASSERT(__zone0_end - __zone0_start >= _Min_Zone0_Size, "DTCM: no room left for the zone")
  ASSERT(__zone_total >= _Min_Zone_Size, "DOOM zone heap below the 704 KB minimum")

  .ARM.attributes 0 : { *(.ARM.attributes) }
}
