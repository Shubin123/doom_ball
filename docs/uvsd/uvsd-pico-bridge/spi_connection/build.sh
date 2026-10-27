
DIR="build/"

if [ ! -d "$DIR" ]; then
    mkdir build
fi
cd build
cmake -DPICO_PLATFORM=rp2350 ..
make