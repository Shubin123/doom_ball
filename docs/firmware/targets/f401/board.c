/*
 * Nucleo-F401RE (STM32F401RE) bring-up, register level:
 *   84 MHz from the ST-Link's 8 MHz MCO (HSE bypass), or from HSI if the
 *   MCO solder bridge is open, LD2 on PA5 (active high), B1 on PC13
 *   (active low), USART2 on PA2/PA3 at 115200 8N1 = the ST-Link USB serial port.
 */
#include "board.h"

static volatile uint32_t ticks;

static void clock_init(void)
{
    uint32_t timeout = 100000;
    uint32_t pllm = 8;

    RCC->CR |= RCC_CR_HSEBYP | RCC_CR_HSEON;
    while (!(RCC->CR & RCC_CR_HSERDY) && --timeout) {
    }
    if (!timeout) {
        RCC->CR &= ~(RCC_CR_HSEON | RCC_CR_HSEBYP);
        pllm = 16;                                   /* 16 MHz HSI */
    }

    RCC->APB1ENR |= RCC_APB1ENR_PWREN;
    PWR->CR = (PWR->CR & ~PWR_CR_VOS) | PWR_CR_VOS_1; /* scale 2: up to 84 MHz */
    FLASH->ACR = FLASH_ACR_ICEN | FLASH_ACR_DCEN | FLASH_ACR_PRFTEN | FLASH_ACR_LATENCY_2WS;

    /* 1 MHz PLL input x 336 / 4 = 84 MHz, / 7 = 48 MHz for USB */
    RCC->PLLCFGR = pllm | (336u << RCC_PLLCFGR_PLLN_Pos) | RCC_PLLCFGR_PLLP_0 |
                   (7u << RCC_PLLCFGR_PLLQ_Pos) | (timeout ? RCC_PLLCFGR_PLLSRC_HSE : 0);
    RCC->CR |= RCC_CR_PLLON;
    while (!(RCC->CR & RCC_CR_PLLRDY)) {
    }
    RCC->CFGR = RCC_CFGR_PPRE1_DIV2 | RCC_CFGR_SW_PLL;
    while ((RCC->CFGR & RCC_CFGR_SWS) != RCC_CFGR_SWS_PLL) {
    }
    SystemCoreClock = 84000000;
}

void board_init(void)
{
    clock_init();

    RCC->AHB1ENR |= RCC_AHB1ENR_GPIOAEN | RCC_AHB1ENR_GPIOCEN;
    RCC->APB1ENR |= RCC_APB1ENR_USART2EN;
    (void)RCC->APB1ENR;

    /* PA5: push-pull output; PA2/PA3: AF7 (USART2); PC13: input with pull-up */
    GPIOA->MODER = (GPIOA->MODER & ~(GPIO_MODER_MODER5 | GPIO_MODER_MODER2 | GPIO_MODER_MODER3)) |
                   GPIO_MODER_MODER5_0 | GPIO_MODER_MODER2_1 | GPIO_MODER_MODER3_1;
    GPIOA->AFR[0] = (GPIOA->AFR[0] & ~(0xFFu << 8)) | (0x77u << 8);
    GPIOA->PUPDR = (GPIOA->PUPDR & ~GPIO_PUPDR_PUPD3) | GPIO_PUPDR_PUPD3_0;
    GPIOC->MODER &= ~GPIO_MODER_MODER13;
    GPIOC->PUPDR = (GPIOC->PUPDR & ~GPIO_PUPDR_PUPD13) | GPIO_PUPDR_PUPD13_0;

    USART2->BRR = (SystemCoreClock / 2 + 115200 / 2) / 115200;   /* APB1 = 42 MHz */
    USART2->CR1 = USART_CR1_UE | USART_CR1_TE | USART_CR1_RE;

    SysTick_Config(SystemCoreClock / 1000);
}

void console_write(const char *buf, int len)
{
    for (int i = 0; i < len; i++) {
        while (!(USART2->SR & USART_SR_TXE)) {
        }
        USART2->DR = (uint8_t)buf[i];
    }
}

int console_getc(void)
{
    if (USART2->SR & USART_SR_RXNE)
        return (int)(USART2->DR & 0xff);
    return -1;
}

void led_toggle(void)
{
    GPIOA->ODR ^= GPIO_ODR_OD5;
}

int button_pressed(void)
{
    return !(GPIOC->IDR & GPIO_IDR_ID13);
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
