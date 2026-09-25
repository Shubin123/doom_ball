/*
 * Blue Pill (STM32F103C8T6) bring-up, register level:
 *   72 MHz from the 8 MHz crystal (64 MHz from HSI if no crystal starts),
 *   LED on PC13 (active low), USART1 on PA9/PA10 at 115200 8N1.
 */
#include "board.h"

static volatile uint32_t ticks;

static void clock_init(void)
{
    uint32_t timeout = 100000;

    RCC->CR |= RCC_CR_HSEON;
    while (!(RCC->CR & RCC_CR_HSERDY) && --timeout) {
    }

    FLASH->ACR = FLASH_ACR_PRFTBE | FLASH_ACR_LATENCY_2;
    if (timeout) {
        /* 8 MHz HSE x 9 = 72 MHz */
        RCC->CFGR = RCC_CFGR_PLLSRC | RCC_CFGR_PLLMULL9 | RCC_CFGR_PPRE1_DIV2;
        SystemCoreClock = 72000000;
    } else {
        /* no crystal: 8 MHz HSI / 2 x 16 = 64 MHz */
        RCC->CR &= ~RCC_CR_HSEON;
        RCC->CFGR = RCC_CFGR_PLLMULL16 | RCC_CFGR_PPRE1_DIV2;
        SystemCoreClock = 64000000;
    }
    RCC->CR |= RCC_CR_PLLON;
    while (!(RCC->CR & RCC_CR_PLLRDY)) {
    }
    RCC->CFGR |= RCC_CFGR_SW_PLL;
    while ((RCC->CFGR & RCC_CFGR_SWS) != RCC_CFGR_SWS_PLL) {
    }
}

void board_init(void)
{
    clock_init();

    RCC->APB2ENR |= RCC_APB2ENR_IOPAEN | RCC_APB2ENR_IOPCEN |
                    RCC_APB2ENR_AFIOEN | RCC_APB2ENR_USART1EN;

    /* PC13: push-pull output, 2 MHz */
    GPIOC->CRH = (GPIOC->CRH & ~(0xFu << 20)) | (0x2u << 20);
    GPIOC->BSRR = GPIO_BSRR_BS13;                    /* LED off */

    /* PA9 TX: AF push-pull 50 MHz; PA10 RX: input with pull-up */
    GPIOA->CRH = (GPIOA->CRH & ~(0xFFu << 4)) | (0xBu << 4) | (0x8u << 8);
    GPIOA->ODR |= GPIO_ODR_ODR10;

    USART1->BRR = (SystemCoreClock + 115200 / 2) / 115200;
    USART1->CR1 = USART_CR1_UE | USART_CR1_TE | USART_CR1_RE;

    SysTick_Config(SystemCoreClock / 1000);
}

void console_write(const char *buf, int len)
{
    for (int i = 0; i < len; i++) {
        while (!(USART1->SR & USART_SR_TXE)) {
        }
        USART1->DR = (uint8_t)buf[i];
    }
}

int console_getc(void)
{
    if (USART1->SR & USART_SR_RXNE)
        return (int)(USART1->DR & 0xff);
    return -1;
}

void led_toggle(void)
{
    GPIOC->ODR ^= GPIO_ODR_ODR13;
}

uint32_t millis(void)
{
    return ticks;
}

void delay_ms(uint32_t ms)
{
    uint32_t start = ticks;

    while (ticks - start < ms) {
    }
}

void board_panic(const char *what)
{
    static const char msg[] = "\r\nPANIC: ";

    __disable_irq();
    console_write(msg, sizeof(msg) - 1);
    while (*what)
        console_write(what++, 1);
    for (;;) {
    }
}

void SysTick_Handler(void)
{
    ticks++;
}

void HardFault_Handler(void)
{
    board_panic("HardFault");
}
