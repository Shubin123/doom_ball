/* USART1 echo example. Connect the IDE serial monitor at 115200 baud. */
#include "board.h"

int main(void)
{
    static const char hello[] = "UART echo ready (115200 8N1)\r\n";

    board_init();
    console_write(hello, (int)(sizeof(hello) - 1));
    for (;;) {
        const int ch = console_getc();
        if (ch < 0)
            continue;
        if (ch == '\r') {
            console_write("\r\n", 2);
        } else if (ch == '\n') {
            /* Ignore the LF paired with a terminal's CR. */
        } else {
            const char byte = (char)ch;
            console_write(&byte, 1);
        }
    }
}
