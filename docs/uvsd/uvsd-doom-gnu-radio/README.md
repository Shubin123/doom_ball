# uvsd-doom-gnu-radio
GNU Radio Companion workspace for doom and python files to help facilitate the demodulating and display of modulated DOOM gameplay in the 915MHz amateur radio band.

To start the viewer and gameplay, start running the workflow in GNUradio, then run ```python doom_raw_sender1.py --file doom_raw.bin```, then start view_doom_zmq.py to view the demodulated gameplay output.

Before running, you need to pip install the following dependencies in the radioconda prompt terminal
```
pyserial
opencv-python
numpy
pyzmq
```
RTL-SDR driver download (not needed until receiving ota) 

Windows: https://www.rtl-sdr.com/tag/zadig/

Linux: `sudo apt-get install rtl-sdr`

## Checking the viewers against the recordings

`tests/replay_recordings.py` feeds `doom_raw.bin` and `colour gameplay/doom_raw_rgb.bin` through
`view_doom_zmq.py` and `view_doom_zmq_rgb.py` as if they came from the flowgraph's ZMQ sink at the
625 ksym/s link rate (with noise, demod gain error and DC offset), and fails if frames are lost.
It needs only NumPy and the Git LFS files (`git lfs pull`):

```
uv run --with numpy python tests/replay_recordings.py
```
