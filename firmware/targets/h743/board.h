#ifndef BOARD_H
#define BOARD_H

#include <stdint.h>
#include "stm32h7xx_hal.h"

#define BOARD_NAME "STM32H743IITx"

void board_init(void);
void board_panic(const char *what) __attribute__((noreturn));

/* CubeMX-style initialization entry points shared by the example projects. */
void SystemClock_Config(void);
void MX_GPIO_Init(void);
void MX_USART1_UART_Init(void);
extern UART_HandleTypeDef huart1;

void console_write(const char *buf, int len);
int console_getc(void);            /* -1 if no byte waiting */
uint32_t buttons_read(void);       /* bit n set = button on pin n pressed */

void led_toggle(void);
uint32_t millis(void);
void delay_ms(uint32_t ms);

void lcd_init(void);
void lcd_fill(uint16_t color);
/* Streams one 320x200 8-bit frame through a 256-entry RGB565 palette. */
void lcd_draw_frame(const uint8_t *pixels, const uint16_t *palette);

int sd_init(void);

#endif
