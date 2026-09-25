# Upstream FreeRTOS-Kernel 11.1.0, GCC ARM_CM7 r0p1 port, and heap_4.
PROJECT_EXTRA_SRCS += $(FW)/third_party/freertos/tasks.c \
	$(FW)/third_party/freertos/list.c \
	$(FW)/third_party/freertos/queue.c \
	$(FW)/third_party/freertos/portable/MemMang/heap_4.c \
	$(FW)/third_party/freertos/portable/GCC/ARM_CM7/r0p1/port.c
INCS += -I$(FW)/projects/freertos \
	-I$(FW)/third_party/freertos/include \
	-I$(FW)/third_party/freertos/portable/GCC/ARM_CM7/r0p1
