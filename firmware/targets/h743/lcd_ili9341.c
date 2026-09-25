/*
 * ILI9341 320x240 SPI LCD, landscape. DOOM's 320x200 frame is centred
 * vertically (20-pixel bars top and bottom).
 */
#include "board.h"
#include "board_config.h"

#define LCD_W   320
#define LCD_H   240
#define FRAME_W 320
#define FRAME_H 200
#define FRAME_Y ((LCD_H - FRAME_H) / 2)

static SPI_HandleTypeDef hspi;
static uint16_t line_buf[2][FRAME_W] __attribute__((section(".sram4"), aligned(32)));

#define PIN_HI(p, n) ((p)->BSRR = (n))
#define PIN_LO(p, n) ((p)->BSRR = (uint32_t)(n) << 16)

static void spi_send(const void *data, uint16_t len)
{
    HAL_SPI_Transmit(&hspi, (uint8_t *)data, len, 100);
}

static void lcd_cmd(uint8_t cmd, const uint8_t *args, uint16_t n)
{
    PIN_LO(LCD_CS_PORT, LCD_CS_PIN);
    PIN_LO(LCD_DC_PORT, LCD_DC_PIN);
    spi_send(&cmd, 1);
    if (n) {
        PIN_HI(LCD_DC_PORT, LCD_DC_PIN);
        spi_send(args, n);
    }
    PIN_HI(LCD_CS_PORT, LCD_CS_PIN);
}

static void lcd_window(uint16_t x0, uint16_t y0, uint16_t x1, uint16_t y1)
{
    uint8_t ca[4] = { x0 >> 8, x0 & 0xff, x1 >> 8, x1 & 0xff };
    uint8_t ra[4] = { y0 >> 8, y0 & 0xff, y1 >> 8, y1 & 0xff };

    lcd_cmd(0x2A, ca, 4);   /* column address set */
    lcd_cmd(0x2B, ra, 4);   /* page address set */
    lcd_cmd(0x2C, 0, 0);    /* memory write */
}

static void gpio_init(void)
{
    GPIO_InitTypeDef gpio = {0};

    __HAL_RCC_GPIOA_CLK_ENABLE();
    __HAL_RCC_GPIOB_CLK_ENABLE();
    __HAL_RCC_SPI1_CLK_ENABLE();

    gpio.Mode = GPIO_MODE_AF_PP;
    gpio.Pull = GPIO_NOPULL;
    gpio.Speed = GPIO_SPEED_FREQ_VERY_HIGH;
    gpio.Alternate = LCD_SPI_AF;
    gpio.Pin = LCD_SCK_PIN;
    HAL_GPIO_Init(LCD_SCK_PORT, &gpio);
    gpio.Pin = LCD_MOSI_PIN;
    HAL_GPIO_Init(LCD_MOSI_PORT, &gpio);

    gpio.Mode = GPIO_MODE_OUTPUT_PP;
    gpio.Speed = GPIO_SPEED_FREQ_HIGH;
    gpio.Alternate = 0;
    gpio.Pin = LCD_CS_PIN;
    HAL_GPIO_Init(LCD_CS_PORT, &gpio);
    gpio.Pin = LCD_DC_PIN;
    HAL_GPIO_Init(LCD_DC_PORT, &gpio);
    gpio.Pin = LCD_RST_PIN;
    HAL_GPIO_Init(LCD_RST_PORT, &gpio);
    gpio.Pin = LCD_BL_PIN;
    HAL_GPIO_Init(LCD_BL_PORT, &gpio);

    PIN_HI(LCD_CS_PORT, LCD_CS_PIN);
    PIN_LO(LCD_BL_PORT, LCD_BL_PIN);
}

static void spi_init(void)
{
    hspi.Instance = LCD_SPI;
    hspi.Init.Mode = SPI_MODE_MASTER;
    hspi.Init.Direction = SPI_DIRECTION_2LINES_TXONLY;
    hspi.Init.DataSize = SPI_DATASIZE_8BIT;
    hspi.Init.CLKPolarity = SPI_POLARITY_LOW;
    hspi.Init.CLKPhase = SPI_PHASE_1EDGE;
    hspi.Init.NSS = SPI_NSS_SOFT;
    hspi.Init.BaudRatePrescaler = LCD_SPI_PRESCALER;
    hspi.Init.FirstBit = SPI_FIRSTBIT_MSB;
    hspi.Init.TIMode = SPI_TIMODE_DISABLE;
    hspi.Init.CRCCalculation = SPI_CRCCALCULATION_DISABLE;
    hspi.Init.NSSPMode = SPI_NSS_PULSE_DISABLE;
    hspi.Init.FifoThreshold = SPI_FIFO_THRESHOLD_01DATA;
    hspi.Init.MasterKeepIOState = SPI_MASTER_KEEP_IO_STATE_ENABLE;
    if (HAL_SPI_Init(&hspi) != HAL_OK)
        board_panic("SPI");
}

void lcd_init(void)
{
    static const uint8_t pwr1[] = { 0x23 };
    static const uint8_t pwr2[] = { 0x10 };
    static const uint8_t vcom1[] = { 0x3E, 0x28 };
    static const uint8_t vcom2[] = { 0x86 };
    static const uint8_t madctl[] = { 0x28 };      /* landscape (MV), BGR */
    static const uint8_t pixfmt[] = { 0x55 };      /* 16 bpp */
    static const uint8_t frmctr[] = { 0x00, 0x18 };
    static const uint8_t dfunc[] = { 0x08, 0x82, 0x27 };

    gpio_init();
    spi_init();

    PIN_LO(LCD_RST_PORT, LCD_RST_PIN);
    HAL_Delay(10);
    PIN_HI(LCD_RST_PORT, LCD_RST_PIN);
    HAL_Delay(120);

    lcd_cmd(0x01, 0, 0);            /* software reset */
    HAL_Delay(120);
    lcd_cmd(0xC0, pwr1, 1);
    lcd_cmd(0xC1, pwr2, 1);
    lcd_cmd(0xC5, vcom1, 2);
    lcd_cmd(0xC7, vcom2, 1);
    lcd_cmd(0x36, madctl, 1);
    lcd_cmd(0x3A, pixfmt, 1);
    lcd_cmd(0xB1, frmctr, 2);
    lcd_cmd(0xB6, dfunc, 3);
    lcd_cmd(0x11, 0, 0);            /* sleep out */
    HAL_Delay(120);
    lcd_cmd(0x29, 0, 0);            /* display on */

    lcd_fill(0x0000);
    PIN_HI(LCD_BL_PORT, LCD_BL_PIN);
}

void lcd_fill(uint16_t color)
{
    uint16_t c = (uint16_t)((color >> 8) | (color << 8));

    for (int i = 0; i < LCD_W; i++)
        line_buf[0][i] = c;

    lcd_window(0, 0, LCD_W - 1, LCD_H - 1);
    PIN_LO(LCD_CS_PORT, LCD_CS_PIN);
    PIN_HI(LCD_DC_PORT, LCD_DC_PIN);
    for (int y = 0; y < LCD_H; y++)
        spi_send(line_buf[0], LCD_W * 2);
    PIN_HI(LCD_CS_PORT, LCD_CS_PIN);
}

void lcd_draw_frame(const uint8_t *pixels, const uint16_t *palette)
{
    lcd_window(0, FRAME_Y, FRAME_W - 1, FRAME_Y + FRAME_H - 1);
    PIN_LO(LCD_CS_PORT, LCD_CS_PIN);
    PIN_HI(LCD_DC_PORT, LCD_DC_PIN);

    for (int y = 0; y < FRAME_H; y++) {
        uint16_t *out = line_buf[y & 1];
        const uint8_t *in = pixels + y * FRAME_W;

        for (int x = 0; x < FRAME_W; x++)
            out[x] = palette[in[x]];
        spi_send(out, FRAME_W * 2);
    }

    PIN_HI(LCD_CS_PORT, LCD_CS_PIN);
}
