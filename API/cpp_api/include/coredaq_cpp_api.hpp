#ifndef COREDAQ_CPP_API_HPP
#define COREDAQ_CPP_API_HPP

#include "coredaq_c_api.h"

#include <array>
#include <stdexcept>
#include <string>
#include <vector>

namespace coredaq {

class CoreDAQError : public std::runtime_error {
public:
    explicit CoreDAQError(const std::string &msg) : std::runtime_error(msg) {}
};

struct Snapshot {
    std::array<float, 4> values{};
    std::array<int, 4> gains{};
};

struct FrameBlock {
    std::vector<float> ch1;
    std::vector<float> ch2;
    std::vector<float> ch3;
    std::vector<float> ch4;
};

class CoreDAQ {
public:
    CoreDAQ();
    ~CoreDAQ();

    CoreDAQ(const CoreDAQ &) = delete;
    CoreDAQ &operator=(const CoreDAQ &) = delete;

    void open(const std::string &port, int baudrate = 115200, int timeout_ms = 150);
    void close();
    bool is_open() const;

    std::string idn();
    std::string frontend_type();

    void set_inter_command_gap_ms(int gap_ms);
    int get_inter_command_gap_ms() const;

    std::array<int, 4> get_gains();
    void set_gain(int head_1_to_4, int gain_0_to_7);

    int get_freq_hz();
    void set_freq_hz(int hz);

    int get_oversampling();
    void set_oversampling(int os_idx);

    int get_channel_mask();
    void set_channel_mask(int mask);

    Snapshot snapshot_adc(int n_frames = 1, int timeout_ms = 1000, int poll_hz = 200);
    Snapshot snapshot_mv(int n_frames = 1, int timeout_ms = 1000, int poll_hz = 200);
    Snapshot snapshot_volts(int n_frames = 1, int timeout_ms = 1000, int poll_hz = 200);
    Snapshot snapshot_w(int n_frames = 1, int timeout_ms = 1000, int poll_hz = 200, float log_deadband_mv = 300.0f);

    void arm_acquisition(int frames, bool use_trigger = false, bool trigger_rising = true);
    void start_acquisition();
    void stop_acquisition();
    void wait_for_completion(int timeout_ms = 60000, int poll_ms = 50);

    FrameBlock transfer_frames_mv(int frames, float log_deadband_mv = 300.0f);
    FrameBlock transfer_frames_volts(int frames, float log_deadband_mv = 300.0f);
    FrameBlock transfer_frames_w(int frames, float log_deadband_mv = 300.0f);

    static std::vector<std::string> find_ports(int timeout_ms = 120);

private:
    coredaq_device_t *dev_;

    [[noreturn]] void throw_last(const std::string &prefix, coredaq_result_t rc) const;
    void check(coredaq_result_t rc, const std::string &prefix) const;
};

} // namespace coredaq

#endif
