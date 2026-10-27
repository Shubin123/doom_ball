#include <stdio.h>
#include "pico/stdlib.h"
#include "hardware/spi.h"
#include "photo.h"
#include "pico/stdio_usb.h"
#include <stdbool.h>
#include <string.h>
#include <stdint.h>
#define SPI_PORT spi0 // GPIO16-19 are SPI0 pins (RX/CSn/SCK/TX)
#define MISO 16
#define CS 17
#define CLOCK_LINE 18
#define MOSI 19

// SPI peripheral at 1 Mhz
#define MHZ 1000000

#define BUF_LEN 6

void read_image_frame(const uint8_t *data, size_t length)
{
    sleep_ms(2000);

    stdio_set_translate_crlf(&stdio_usb, false);

    char header[64];

    snprintf(header, sizeof(header), "Received image frame of length: %zu\n", length);

    stdio_put_string(header, strlen(header), false, false);

    sleep_ms(200);

    const size_t chunk_size = 3072;
    size_t bytes_sent = 0;

    while (bytes_sent < length)
    {
        size_t bytes_to_send = (length - bytes_sent) < chunk_size ? (length - bytes_sent) : chunk_size;

        for (size_t i = 0; i < bytes_to_send; i++)
        {
            putchar_raw(data[bytes_sent + i]);
        }
        bytes_sent += bytes_to_send;
        sleep_ms(2);
    }
    const char END_OF_FILE_MARKER[] = "\n__IMAGE_EOF__\n";
    stdio_put_string(END_OF_FILE_MARKER, strlen(END_OF_FILE_MARKER), false, false);
    stdio_set_translate_crlf(&stdio_usb, true);
}

int main()
{
    stdio_init_all();

    // printf("SPI SLAVE INIT... \n");

    // spi_init(SPI_PORT, MHZ);

    // gpio_set_function(MISO, GPIO_FUNC_SPI);
    // gpio_set_function(CS, GPIO_FUNC_SPI);
    // gpio_set_function(CLOCK_LINE, GPIO_FUNC_SPI);
    // gpio_set_function(MOSI, GPIO_FUNC_SPI);

    // spi_set_format(SPI_PORT, 8, SPI_CPOL_0, 0, SPI_MSB_FIRST);

    // spi_set_slave(SPI_PORT, true);

    // printf("SPI SLAVE INIT DONE... \n");
    // uint8_t out_buf[BUF_LEN] = {'H', 'E', 'L', 'L', 'O', '!'};
    // uint8_t in_buf[BUF_LEN] = {0};

    // this would be the equivalent to 
    read_image_frame(photo_jpg, photo_jpg_len);

    while (true)
    {
        tight_loop_contents();
    }
    return 0;
}