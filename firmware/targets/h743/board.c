/*
 * STM32H743 board bring-up: clocks, caches, console UART, buttons.
 */
#include "board.h"
#include "board_config.h"

UART_HandleTypeDef huart1;

/* USART1 RX ring buffer, filled from the interrupt so key presses are not
 * lost while a frame is being rendered or streamed to the LCD. */
static volatile uint8_t rx_buf[256];
static volatile uint8_t rx_head, rx_tail;

static void clock_init(void)
{
    RCC_OscInitTypeDef osc = {0};
    RCC_ClkInitTypeDef clk = {0};

    HAL_PWREx_ConfigSupply(PWR_LDO_SUPPLY);
    __HAL_PWR_VOLTAGESCALING_CONFIG(PWR_REGULATOR_VOLTAGE_SCALE1);
    while (!__HAL_PWR_GET_FLAG(PWR_FLAG_VOSRDY)) {
    }

    /*
     * PLL1 from the internal 64 MHz HSI so the port works regardless of
     * the crystal fitted: 64 / 4 = 16 MHz ref, x50 = 800 MHz VCO,
     * P = /2 -> 400 MHz CPU, Q = /8 -> 100 MHz for SPI1 and SDMMC1.
     */
    osc.OscillatorType = RCC_OSCILLATORTYPE_HSI;
    osc.HSIState = RCC_HSI_DIV1;
    osc.HSICalibrationValue = RCC_HSICALIBRATION_DEFAULT;
    osc.PLL.PLLState = RCC_PLL_ON;
    osc.PLL.PLLSource = RCC_PLLSOURCE_HSI;
    osc.PLL.PLLM = 4;
    osc.PLL.PLLN = 50;
    osc.PLL.PLLP = 2;
    osc.PLL.PLLQ = 8;
    osc.PLL.PLLR = 2;
    osc.PLL.PLLRGE = RCC_PLL1VCIRANGE_3;
    osc.PLL.PLLVCOSEL = RCC_PLL1VCOWIDE;
    osc.PLL.PLLFRACN = 0;
    if (HAL_RCC_OscConfig(&osc) != HAL_OK)
        board_panic("PLL");

    clk.ClockType = RCC_CLOCKTYPE_HCLK | RCC_CLOCKTYPE_SYSCLK |
                    RCC_CLOCKTYPE_PCLK1 | RCC_CLOCKTYPE_PCLK2 |
                    RCC_CLOCKTYPE_D3PCLK1 | RCC_CLOCKTYPE_D1PCLK1;
    clk.SYSCLKSource = RCC_SYSCLKSOURCE_PLLCLK;
    clk.SYSCLKDivider = RCC_SYSCLK_DIV1;
    clk.AHBCLKDivider = RCC_HCLK_DIV2;          /* 200 MHz AXI/AHB */
    clk.APB3CLKDivider = RCC_APB3_DIV2;         /* 100 MHz */
    clk.APB1CLKDivider = RCC_APB1_DIV2;
    clk.APB2CLKDivider = RCC_APB2_DIV2;
    clk.APB4CLKDivider = RCC_APB4_DIV2;
    if (HAL_RCC_ClockConfig(&clk, FLASH_LATENCY_2) != HAL_OK)
        board_panic("CLK");
}

static void console_init(void)
{
    GPIO_InitTypeDef gpio = {0};

    __HAL_RCC_GPIOA_CLK_ENABLE();
    __HAL_RCC_USART1_CLK_ENABLE();

    gpio.Pin = GPIO_PIN_9 | GPIO_PIN_10;
    gpio.Mode = GPIO_MODE_AF_PP;
    gpio.Pull = GPIO_PULLUP;
    gpio.Speed = GPIO_SPEED_FREQ_HIGH;
    gpio.Alternate = GPIO_AF7_USART1;
    HAL_GPIO_Init(GPIOA, &gpio);

    huart1.Instance = USART1;
    huart1.Init.BaudRate = CONSOLE_BAUD;
    huart1.Init.WordLength = UART_WORDLENGTH_8B;
    huart1.Init.StopBits = UART_STOPBITS_1;
    huart1.Init.Parity = UART_PARITY_NONE;
    huart1.Init.Mode = UART_MODE_TX_RX;
    huart1.Init.HwFlowCtl = UART_HWCONTROL_NONE;
    huart1.Init.OverSampling = UART_OVERSAMPLING_16;
    HAL_UART_Init(&huart1);

    USART1->CR1 |= USART_CR1_RXNEIE_RXFNEIE;
    HAL_NVIC_SetPriority(USART1_IRQn, 5, 0);
    HAL_NVIC_EnableIRQ(USART1_IRQn);
}

static void led_init(void)
{
    GPIO_InitTypeDef gpio = {0};

    __HAL_RCC_GPIOC_CLK_ENABLE();
    gpio.Pin = LED_PIN;
    gpio.Mode = GPIO_MODE_OUTPUT_PP;
    gpio.Speed = GPIO_SPEED_FREQ_LOW;
    HAL_GPIO_Init(LED_PORT, &gpio);
    HAL_GPIO_WritePin(LED_PORT, LED_PIN, GPIO_PIN_SET);     /* off */
}

void led_toggle(void)
{
    HAL_GPIO_TogglePin(LED_PORT, LED_PIN);
}

uint32_t millis(void)
{
    return HAL_GetTick();
}

void delay_ms(uint32_t ms)
{
    HAL_Delay(ms);
}

static void buttons_init(void)
{
    GPIO_InitTypeDef gpio = {0};

    __HAL_RCC_GPIOE_CLK_ENABLE();
    gpio.Pin = BTN_UP_PIN | BTN_DOWN_PIN | BTN_LEFT_PIN | BTN_RIGHT_PIN |
               BTN_FIRE_PIN | BTN_USE_PIN | BTN_ENTER_PIN | BTN_ESC_PIN;
    gpio.Mode = GPIO_MODE_INPUT;
    gpio.Pull = GPIO_PULLUP;
    HAL_GPIO_Init(BUTTONS_PORT, &gpio);
}

void board_init(void)
{
    SCB_EnableICache();
    SCB_EnableDCache();
    HAL_Init();
    clock_init();
    console_init();
    led_init();
    buttons_init();
}

void console_write(const char *buf, int len)
{
    HAL_UART_Transmit(&huart1, (const uint8_t *)buf, (uint16_t)len, 100);
}

int console_getc(void)
{
    int c;

    if (rx_tail == rx_head)
        return -1;
    c = rx_buf[rx_tail];
    rx_tail = (uint8_t)(rx_tail + 1);
    return c;
}

void USART1_IRQHandler(void)
{
    USART_TypeDef *u = USART1;
    uint32_t isr = u->ISR;

    if (isr & (USART_ISR_ORE | USART_ISR_FE | USART_ISR_NE | USART_ISR_PE))
        u->ICR = USART_ICR_ORECF | USART_ICR_FECF | USART_ICR_NECF | USART_ICR_PECF;
    while (u->ISR & USART_ISR_RXNE_RXFNE) {
        uint8_t c = (uint8_t)u->RDR;
        uint8_t next = (uint8_t)(rx_head + 1);

        if (next != rx_tail) {
            rx_buf[rx_head] = c;
            rx_head = next;
        }
    }
}

uint32_t buttons_read(void)
{
    /* active low -> 1 = pressed */
    return (~BUTTONS_PORT->IDR) & 0xffu;
}

void board_panic(const char *what)
{
    static const char msg[] = "\r\nPANIC: ";

    __disable_irq();
    HAL_UART_Transmit(&huart1, (const uint8_t *)msg, sizeof(msg) - 1, 100);
    while (*what)
        HAL_UART_Transmit(&huart1, (const uint8_t *)what++, 1, 100);
    for (;;) {
    }
}

/* ---- interrupt handlers ---- */

void SysTick_Handler(void)
{
    HAL_IncTick();
}

void HardFault_Handler(void)
{
    board_panic("HardFault");
}

void MemManage_Handler(void)
{
    board_panic("MemManage");
}

void BusFault_Handler(void)
{
    board_panic("BusFault");
}

void UsageFault_Handler(void)
{
    board_panic("UsageFault");
}
