#include "coredaq_cpp_api.hpp"

#include <iostream>

int main(int argc, char **argv) {
    const std::string port = (argc > 1) ? argv[1] : "COM5";

    try {
        coredaq::CoreDAQ dev;
        dev.open(port, 115200, 200);

        std::cout << "IDN: " << dev.idn() << "\n";
        std::cout << "Frontend: " << dev.frontend_type() << "\n";

        coredaq::Snapshot s = dev.snapshot_w(1, 1200, 200, 300.0f);
        for (int i = 0; i < 4; ++i) {
            std::cout << "CH" << (i + 1) << ": " << s.values[i] << " W (gain=" << s.gains[i] << ")\n";
        }

        dev.close();
        return 0;
    } catch (const std::exception &e) {
        std::cerr << "Error: " << e.what() << "\n";
        return 1;
    }
}
