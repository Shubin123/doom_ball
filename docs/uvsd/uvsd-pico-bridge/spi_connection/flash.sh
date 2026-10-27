#!/usr/bin/env bash
PROJECT_UF2=spi_connection.uf2 

DESTINATION=$1

if [[ -n "$DESTINATION" ]]; then
    cp -r ./build/$PROJECT_UF2 $DESTINATION
else 
    echo "Must Provide a desitnation file (must be route to PICO) ex: /Volumes/RP2350 (macOS) or /media/$USER/RP2350 (Linux)"
fi