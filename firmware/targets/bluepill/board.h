#ifndef BOARD_H
#define BOARD_H

#include <stdint.h>
#include "stm32f1xx.h"

#define BOARD_NAME "STM32F103C8T6 Blue Pill"

void board_init(void);
void board_panic(const char *what) __attribute__((noreturn));

void console_write(const char *buf, int len);
int console_getc(void);             /* -1 if no byte waiting */

void led_toggle(void);
uint32_t millis(void);
void delay_ms(uint32_t ms);

#endif
