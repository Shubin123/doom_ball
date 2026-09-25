#ifndef BOARD_H
#define BOARD_H

#include <stdint.h>
#include "stm32f4xx.h"

#define BOARD_NAME "STM32F401RE Nucleo-F401RE"

void board_init(void);
void board_panic(const char *what) __attribute__((noreturn));

void console_write(const char *buf, int len);
int console_getc(void);             /* -1 if no byte waiting */

void led_toggle(void);
int button_pressed(void);           /* blue B1 button on PC13 */
uint32_t millis(void);
void delay_ms(uint32_t ms);

#endif
