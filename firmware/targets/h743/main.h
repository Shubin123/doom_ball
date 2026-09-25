/* Common CubeMX-style application header for the STM32H743 projects. */
#ifndef STM32_FORGE_MAIN_H
#define STM32_FORGE_MAIN_H

#include "stm32h7xx_hal.h"
#include "board.h"
#include "board_config.h"

extern UART_HandleTypeDef huart1;

void SystemClock_Config(void);
void MX_GPIO_Init(void);
void MX_USART1_UART_Init(void);

#endif
