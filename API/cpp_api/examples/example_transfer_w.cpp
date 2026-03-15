#include "coredaq_cpp_api.hpp"

#include <algorithm>
#include <iostream>

int main(int argc, char **argv) {
    const std::string port = (argc > 1) ? argv[1] : "COM5";
    const int frames = (argc > 2) ? std::max(1, std::atoi(argv[2])) : 2000;

    try {
        coredaq::CoreDAQ dev;
        dev.open(port, 115200, 300);
        dev.set_channel_mask(0x0F);

        dev.arm_acquisition(frames, true, true);
        std::cout << "Armed for trigger. Waiting...\n";
        dev.wait_for_completion(20000, 50);

        coredaq::FrameBlock fb = dev.transfer_frames_w(frames, 300.0f);
        std::cout << "Transferred " << frames << " frames (W). First 8 samples:\n";
        for (int i = 0; i < std::min(frames, 8); ++i) {
            std::cout << i << ": "
                      << fb.ch1[i] << ", "
                      << fb.ch2[i] << ", "
                      << fb.ch3[i] << ", "
                      << fb.ch4[i] << "\n";
        }
        dev.close();
        return 0;
    } catch (const std::exception &e) {
        std::cerr << "Error: " << e.what() << "\n";
        return 1;
    }
}
