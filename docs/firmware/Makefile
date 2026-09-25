# STM32 Forge firmware build
#
#   make TARGET=h743     PROJECT=doom      DOOM on the STM32H743IITx
#   make TARGET=bluepill PROJECT=blinky    LED + UART demo on the Blue Pill
#   make TARGET=bluepill PROJECT=doom      shows DOOM does not fit (64K/20K)
#   make TARGET=h743     PROJECT=blinky
#
# Output: build/$(TARGET)-$(PROJECT)/firmware.{elf,bin,hex,map}
# The linker's per-region memory usage is printed at the end of each link.

TARGET  ?= h743
PROJECT ?= doom

ROOT    := $(abspath $(dir $(lastword $(MAKEFILE_LIST)))/..)
FW      := $(ROOT)/firmware
TP      := $(FW)/third_party
ENGINE  := $(ROOT)/engine/doomgeneric
BUILD   ?= $(FW)/build/$(TARGET)-$(PROJECT)

# Toolchain: PATH, or ARM_GCC_PATH=/path/to/bin
ifdef ARM_GCC_PATH
PREFIX  := $(ARM_GCC_PATH)/arm-none-eabi-
else
PREFIX  := arm-none-eabi-
endif
CC      := $(PREFIX)gcc
OBJCOPY := $(PREFIX)objcopy
SIZE    := $(PREFIX)size

OPT     ?= -O2 -g3

# ---------------------------------------------------------------- targets --
ifeq ($(TARGET),h743)
CPU      := -mcpu=cortex-m7 -mthumb -mfpu=fpv5-d16 -mfloat-abi=hard
LDSCRIPT := $(FW)/targets/h743/h743.ld
DEFS     := -DSTM32H743xx -DUSE_HAL_DRIVER
INCS     := -I$(FW)/targets/h743 -I$(TP)/cmsis/core -I$(TP)/cmsis/device_h7 \
            -I$(TP)/stm32h7xx_hal/Inc -I$(TP)/fatfs
HAL_SRCS := $(addprefix $(TP)/stm32h7xx_hal/Src/stm32h7xx_, \
            hal.c hal_cortex.c hal_rcc.c hal_rcc_ex.c hal_gpio.c hal_pwr.c \
            hal_pwr_ex.c hal_sd.c hal_sd_ex.c ll_sdmmc.c ll_delayblock.c \
            hal_spi.c hal_spi_ex.c hal_uart.c hal_uart_ex.c hal_dma.c \
            hal_dma_ex.c hal_mdma.c hal_flash.c hal_flash_ex.c)
BSP_SRCS := $(TP)/cmsis/device_h7/system_stm32h7xx.c \
            $(FW)/targets/h743/board.c $(FW)/targets/h743/syscalls.c
ASM_SRCS := $(TP)/cmsis/device_h7/startup_stm32h743xx.s
DOOM_BSP := $(FW)/targets/h743/dg_stm32.c $(FW)/targets/h743/lcd_ili9341.c \
            $(FW)/targets/h743/sd_diskio.c $(FW)/targets/h743/syscalls_fatfs.c \
            $(TP)/fatfs/ff.c $(TP)/fatfs/ffunicode.c
else ifeq ($(TARGET),bluepill)
CPU      := -mcpu=cortex-m3 -mthumb
LDSCRIPT := $(FW)/targets/bluepill/bluepill.ld
DEFS     := -DSTM32F103xB
INCS     := -I$(FW)/targets/bluepill -I$(TP)/cmsis/core -I$(TP)/cmsis/device_f1
HAL_SRCS :=
BSP_SRCS := $(TP)/cmsis/device_f1/system_stm32f1xx.c \
            $(FW)/targets/bluepill/board.c $(FW)/targets/bluepill/syscalls.c
ASM_SRCS := $(TP)/cmsis/device_f1/startup_stm32f103xb.s
DOOM_BSP := $(FW)/targets/bluepill/dg_bluepill.c
else
$(error Unknown TARGET '$(TARGET)' (use h743 or bluepill))
endif

# --------------------------------------------------------------- projects --
ifeq ($(PROJECT),doom)
DOOM_DEFS := -DCMAP256 -DDG_NO_SCREENBUFFER -DDG_ZONE_PROVIDER -DDG_NO_WIPE \
             -DDG_ZONE_STATIC_TOP -DDG_STATES_IN_FLASH -DDOOMGENERIC_RESX=320 -DDOOMGENERIC_RESY=200
APP_SRCS  := $(DOOM_BSP)
ENG_SRCS  := $(wildcard $(ENGINE)/*.c)
INCS      += -I$(ENGINE)
DEFS      += $(DOOM_DEFS)
else ifeq ($(PROJECT),blinky)
APP_SRCS  := $(FW)/projects/blinky/main.c
ENG_SRCS  :=
else
$(error Unknown PROJECT '$(PROJECT)' (use doom or blinky))
endif

CFLAGS  := $(CPU) $(OPT) $(DEFS) $(INCS) -std=gnu11 -Wall \
           -ffunction-sections -fdata-sections -fno-common -MMD -MP
# The engine is upstream code; keep its (many) legacy warnings out of the log.
ENG_CFLAGS := $(filter-out -std=gnu11 -Wall,$(CFLAGS)) -std=gnu99 -w
LDFLAGS := $(CPU) -T$(LDSCRIPT) --specs=nano.specs --specs=nosys.specs \
           -Wl,--gc-sections -Wl,-Map=$(BUILD)/firmware.map \
           -Wl,--print-memory-usage -Wl,--no-warn-rwx-segments

SRCS    := $(HAL_SRCS) $(BSP_SRCS) $(APP_SRCS)
OBJS    := $(patsubst $(ROOT)/%.c,$(BUILD)/%.o,$(SRCS)) \
           $(patsubst $(ROOT)/%.c,$(BUILD)/%.o,$(ENG_SRCS)) \
           $(patsubst $(ROOT)/%.s,$(BUILD)/%.o,$(ASM_SRCS))

all: $(BUILD)/firmware.bin $(BUILD)/firmware.hex
	@$(SIZE) $(BUILD)/firmware.elf

$(BUILD)/engine/%.o: $(ROOT)/engine/%.c
	@mkdir -p $(dir $@)
	@echo "CC  $<"
	@$(CC) $(ENG_CFLAGS) -c $< -o $@

$(BUILD)/%.o: $(ROOT)/%.c
	@mkdir -p $(dir $@)
	@echo "CC  $<"
	@$(CC) $(CFLAGS) -c $< -o $@

$(BUILD)/%.o: $(ROOT)/%.s
	@mkdir -p $(dir $@)
	@echo "AS  $<"
	@$(CC) $(CPU) -x assembler-with-cpp -c $< -o $@

$(BUILD)/firmware.elf: $(OBJS) $(LDSCRIPT)
	@echo "LD  $@"
	@$(CC) $(OBJS) $(LDFLAGS) -lm -o $@

$(BUILD)/firmware.bin: $(BUILD)/firmware.elf
	@$(OBJCOPY) -O binary $< $@

$(BUILD)/firmware.hex: $(BUILD)/firmware.elf
	@$(OBJCOPY) -O ihex $< $@

clean:
	rm -rf $(BUILD)

.PHONY: all clean

-include $(OBJS:.o=.d)
