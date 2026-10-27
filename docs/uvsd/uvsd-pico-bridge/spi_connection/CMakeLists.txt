cmake_minimum_required(VERSION 3.12)

# Pull in SDK (must be before project)
include(pico_sdk_import.cmake)

project(spi_connection C CXX ASM)

set(CMAKE_C_STANDARD 11)
set(CMAKE_CXX_STANDARD 17)

if (PICO_SDK_VERSION_STRING VERSION_LESS "2.3.0")
    message(FATAL_ERROR "Raspberry Pi Pico SDK version 2.3.0 (or later) required. Your version is ${PICO_SDK_VERSION_STRING}")
endif()

# Initialize the SDK
pico_sdk_init()

add_executable(spi_connection
    spi_connection.c
)

pico_enable_stdio_usb(spi_connection 1)
# The image goes to the laptop over USB only. With UART stdio left on, every
# byte also waits on GPIO0 at 115200 baud, which caps the transfer at ~11 kB/s.
pico_enable_stdio_uart(spi_connection 0)

# photo.h (xxd -i photo.jpg) is not committed. When it is missing, generate the
# same array from PHOTO_JPG so a fresh clone builds; the default is a DOOM
# E1M1 frame. Pass -DPHOTO_JPG=/path/to/image.jpg to embed another image.
set(PHOTO_JPG "${CMAKE_CURRENT_SOURCE_DIR}/sample_frame.jpg" CACHE FILEPATH
    "JPEG embedded in the firmware when spi_connection/photo.h is absent")
if (NOT EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/photo.h")
    file(READ "${PHOTO_JPG}" PHOTO_HEX HEX)
    string(LENGTH "${PHOTO_HEX}" PHOTO_HEX_LEN)
    math(EXPR PHOTO_LEN "${PHOTO_HEX_LEN} / 2")
    string(REGEX REPLACE "([0-9a-f][0-9a-f])" "0x\\1," PHOTO_BYTES "${PHOTO_HEX}")
    file(WRITE "${CMAKE_CURRENT_BINARY_DIR}/generated/photo.h"
        "unsigned char photo_jpg[] = {${PHOTO_BYTES}};\nunsigned int photo_jpg_len = ${PHOTO_LEN};\n")
    target_include_directories(spi_connection PRIVATE "${CMAKE_CURRENT_BINARY_DIR}/generated")
    set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${PHOTO_JPG}")
endif()

# LINK HARDWARE_SPI HERE:
target_link_libraries(spi_connection 
    pico_stdlib
    hardware_spi
)

if (PICO_CYW43_SUPPORTED)
    target_link_libraries(spi_connection pico_cyw43_arch_none)
endif()

pico_add_extra_outputs(spi_connection)
