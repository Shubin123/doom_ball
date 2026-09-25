/*
 * Board wiring for the STM32H743IITx DOOM port.
 *
 * Defaults target a bare H743IITx board with:
 *   - ILI9341 320x240 SPI LCD on SPI1
 *   - microSD card on SDMMC1 (4-bit) holding DOOM1.WAD
 *   - USART1 on PA9/PA10: console + keyboard input (same pins as the ROM
 *     bootloader, so one USB-UART adapter flashes, logs and plays)
 *   - optional active-low push buttons on port E
 *
 * Change the pins here to match your hardware.
 */
#ifndef BOARD_CONFIG_H
#define BOARD_CONFIG_H

/* ---- LCD (ILI9341, SPI1 AF5) ---- */
#define LCD_SPI                 SPI1
#define LCD_SCK_PORT            GPIOA
#define LCD_SCK_PIN             GPIO_PIN_5
#define LCD_MOSI_PORT           GPIOA
#define LCD_MOSI_PIN            GPIO_PIN_7
#define LCD_SPI_AF              GPIO_AF5_SPI1
#define LCD_CS_PORT             GPIOA
#define LCD_CS_PIN              GPIO_PIN_4
#define LCD_DC_PORT             GPIOB
#define LCD_DC_PIN              GPIO_PIN_1
#define LCD_RST_PORT            GPIOB
#define LCD_RST_PIN             GPIO_PIN_0
#define LCD_BL_PORT             GPIOB           /* backlight enable, active high */
#define LCD_BL_PIN              GPIO_PIN_2
/* SPI kernel clock is PLL1Q = 100 MHz; prescaler 2 -> 50 MHz SCK */
#define LCD_SPI_PRESCALER       SPI_BAUDRATEPRESCALER_2

/* ---- microSD (SDMMC1: PC8-PC11 = D0-D3, PC12 = CK, PD2 = CMD) ---- */
/* SDMMC kernel clock is PLL1Q = 100 MHz; CK = 100 / (2 * DIV) = 25 MHz */
#define SD_CLOCK_DIV            2
#define WAD_PATH                "0:/DOOM1.WAD"

/* ---- Status LED (active low) ---- */
#define LED_PORT                GPIOC
#define LED_PIN                 GPIO_PIN_13

/* ---- Console / key input (USART1, AF7) ---- */
#define CONSOLE_BAUD            115200

/* ---- Optional buttons (active low, internal pull-ups) ---- */
#define BUTTONS_PORT            GPIOE
#define BTN_UP_PIN              GPIO_PIN_0
#define BTN_DOWN_PIN            GPIO_PIN_1
#define BTN_LEFT_PIN            GPIO_PIN_2
#define BTN_RIGHT_PIN           GPIO_PIN_3
#define BTN_FIRE_PIN            GPIO_PIN_4
#define BTN_USE_PIN             GPIO_PIN_5
#define BTN_ENTER_PIN           GPIO_PIN_6
#define BTN_ESC_PIN             GPIO_PIN_7

#endif
