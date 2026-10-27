"""
main.py 
"""

import sys
from serial import Serial
from time import sleep
END_OF_FILE_MARKER = b"\n__IMAGE_EOF__\n"


class USBConnection:
    def __init__(
        self,
        port: str,
        baudrate: int,
        destination_file: str ="frame_output.jpg",
        payload: bytearray = bytearray(),
    ):
        self.payload = payload
        self.port = port
        self.baudrate = baudrate

        # View frame
        # Temporary code to save a current frame
        self.destination_file_name = destination_file
        
        self.serial_connection = None
        self.chunk_data = None
        self.frame_data = None

    def open_connection(self): # -> throws AssertionError, and TimeoutError if it can't connect
        # only open a connection if there does not currently exist one.
        assert self.serial_connection is None, "Only open a connection if there doesn't exist one"
        connection_tries = 0
        # Create Serial Connection
        while connection_tries < 5:
            try:
                self.serial_connection = Serial(port=self.port, baudrate=self.baudrate)
                break
            except Exception as err:
                connection_tries+=1 
                sleep(2)
                continue
        
        if not self.serial_connection:
            raise TimeoutError("Could not open a serial connection after 5 tries")
        # the first line is the header of the file set by the PICO
        header_line = (
            self.serial_connection
                .readline()
                .decode("utf-8", errors="replace")
                .strip()
        )
        print(f"Reported Pico Frame: {header_line}")
        
        

    def read_frame_data(self, byte_size:int = 1_000_000): # -> throws an AssertionError
        """
        Function: read_frame_data
        This function handles the connection/read loop.
        The algorithm fetches data from the PICO,
        Extends the `self.payload` byte array,
        Terminates once the serial connection reads a b"EOF", which must be configured on the RasperryPI Pico
        ARGS: 
            byte_size: int, defaults to 1 Mbps, this simply sets the rate at which the USB cord will 
            fetch data provided by the PICO
        RETURN: Nothing
        """
        assert self.serial_connection is not None, "No Connection to read frame data from"
        
        while True:
          
            # No read timeout is set, so read(n) blocks until n bytes arrive; ask only for
            # what is already buffered (at least 1 byte) so a short image doesn't hang here.
            self.chunk_data = self.serial_connection.read(
                min(byte_size, max(1, self.serial_connection.in_waiting))
            )
           
                
            
            if not self.chunk_data:
                continue
            if self.chunk_data == b"EOF":
                break
            self.payload.extend(self.chunk_data)
            if self.payload.endswith(END_OF_FILE_MARKER):
                print("End of file marker received. Writing to file.")
                break
            print(f"Received {len(self.chunk_data)} bytes, total received: {len(self.payload)} bytes")

       
    def write_frame_data(self):
        """
        write_frame_data recieves the completed payload bytearray and sets `self.frame_data`
        and attempts to write the completed frame data to the temporary destination file 
        """
        try:
            self.file = open(self.destination_file_name, "wb")
            self.frame_data = self.payload[: -len(END_OF_FILE_MARKER)]


            soi_index = self.frame_data.find(b"\xff\xd8")
            if soi_index != -1:
                self.frame_data = self.frame_data[soi_index:]
            else:
                print("Warning: JPEG SOI marker (FF D8) not found! File may be invalid.")
            
        
            self.file.write(self.frame_data)
        except Exception as err:
            print(err)

    def clean_up(self):
        """
        Cleans up the payload byte array
        closes the file
        and closes the serial connection
        """
        
        self.file.close()
        self.serial_connection.close()
        self.payload.clear()


def main():
    # The port changes by machine: pass it as the first argument, e.g.
    # `uv run usb /dev/cu.usbmodem1101` on macOS (default /dev/ttyACM0, Linux).
    # An optional second argument names the output file.
    port = sys.argv[1] if len(sys.argv) > 1 else "/dev/ttyACM0"
    destination_file = sys.argv[2] if len(sys.argv) > 2 else "frame_output.jpg"
    
    payload = bytearray()
    
    # COULD BE MODIFIED TO INCREASE TRANSFER SPEED
    baudrate = 115200
    
    usbcon: USBConnection = USBConnection(
        port=port, baudrate=baudrate, destination_file=destination_file, payload=payload
    )
    
    # Open Connection
    usbcon.open_connection() 
    
    # Read from USB
    usbcon.read_frame_data()
    
    # Write frame data
    usbcon.write_frame_data()
    
    # Clean Up environment
    usbcon.clean_up()


if __name__ == "__main__":
    main()
