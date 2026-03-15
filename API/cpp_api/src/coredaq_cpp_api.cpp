#include "coredaq_cpp_api.hpp"

#include <sstream>

namespace coredaq {

CoreDAQ::CoreDAQ() : dev_(nullptr) {
    coredaq_result_t rc = coredaq_create(&dev_);
    if (rc != COREDAQ_OK || !dev_) {
        throw CoreDAQError("coredaq_create failed");
    }
}

CoreDAQ::~CoreDAQ() {
    if (dev_) {
        coredaq_destroy(dev_);
        dev_ = nullptr;
    }
}

void CoreDAQ::throw_last(const std::string &prefix, coredaq_result_t rc) const {
    std::ostringstream oss;
    oss << prefix << ": " << coredaq_result_string(rc);
    if (dev_) {
        const char *detail = coredaq_last_error(dev_);
        if (detail && *detail) {
            oss << " (" << detail << ")";
        }
    }
    throw CoreDAQError(oss.str());
}

void CoreDAQ::check(coredaq_result_t rc, const std::string &prefix) const {
    if (rc != COREDAQ_OK) {
        throw_last(prefix, rc);
    }
}

void CoreDAQ::open(const std::string &port, int baudrate, int timeout_ms) {
    check(coredaq_open(dev_, port.c_str(), baudrate, timeout_ms), "open");
}

void CoreDAQ::close() {
    coredaq_close(dev_);
}

bool CoreDAQ::is_open() const {
    return coredaq_is_open(dev_) != 0;
}

std::string CoreDAQ::idn() {
    char buf[256] = {0};
    check(coredaq_idn(dev_, buf, sizeof(buf)), "idn");
    return std::string(buf);
}

std::string CoreDAQ::frontend_type() {
    char buf[32] = {0};
    check(coredaq_frontend_type(dev_, buf, sizeof(buf)), "frontend_type");
    return std::string(buf);
}

void CoreDAQ::set_inter_command_gap_ms(int gap_ms) {
    check(coredaq_set_inter_command_gap_ms(dev_, gap_ms), "set_inter_command_gap_ms");
}

int CoreDAQ::get_inter_command_gap_ms() const {
    int v = 0;
    check(coredaq_get_inter_command_gap_ms(dev_, &v), "get_inter_command_gap_ms");
    return v;
}

std::array<int, 4> CoreDAQ::get_gains() {
    std::array<int, 4> out{};
    check(coredaq_get_gains(dev_, out.data()), "get_gains");
    return out;
}

void CoreDAQ::set_gain(int head_1_to_4, int gain_0_to_7) {
    check(coredaq_set_gain(dev_, head_1_to_4, gain_0_to_7), "set_gain");
}

int CoreDAQ::get_freq_hz() {
    int hz = 0;
    check(coredaq_get_freq_hz(dev_, &hz), "get_freq_hz");
    return hz;
}

void CoreDAQ::set_freq_hz(int hz) {
    check(coredaq_set_freq_hz(dev_, hz), "set_freq_hz");
}

int CoreDAQ::get_oversampling() {
    int os = 0;
    check(coredaq_get_oversampling(dev_, &os), "get_oversampling");
    return os;
}

void CoreDAQ::set_oversampling(int os_idx) {
    check(coredaq_set_oversampling(dev_, os_idx), "set_oversampling");
}

int CoreDAQ::get_channel_mask() {
    int mask = 0;
    check(coredaq_get_channel_mask(dev_, &mask), "get_channel_mask");
    return mask;
}

void CoreDAQ::set_channel_mask(int mask) {
    check(coredaq_set_channel_mask(dev_, mask), "set_channel_mask");
}

Snapshot CoreDAQ::snapshot_adc(int n_frames, int timeout_ms, int poll_hz) {
    Snapshot s;
    int codes[4] = {0, 0, 0, 0};
    check(coredaq_snapshot_adc(dev_, n_frames, timeout_ms, poll_hz, codes, s.gains.data()), "snapshot_adc");
    for (int i = 0; i < 4; ++i) {
        s.values[i] = static_cast<float>(codes[i]);
    }
    return s;
}

Snapshot CoreDAQ::snapshot_mv(int n_frames, int timeout_ms, int poll_hz) {
    Snapshot s;
    check(coredaq_snapshot_mv(dev_, n_frames, timeout_ms, poll_hz, s.values.data(), s.gains.data()), "snapshot_mv");
    return s;
}

Snapshot CoreDAQ::snapshot_volts(int n_frames, int timeout_ms, int poll_hz) {
    Snapshot s;
    check(coredaq_snapshot_volts(dev_, n_frames, timeout_ms, poll_hz, s.values.data(), s.gains.data()), "snapshot_volts");
    return s;
}

Snapshot CoreDAQ::snapshot_w(int n_frames, int timeout_ms, int poll_hz, float log_deadband_mv) {
    Snapshot s;
    check(coredaq_snapshot_w(dev_, n_frames, timeout_ms, poll_hz, log_deadband_mv, s.values.data(), s.gains.data()), "snapshot_w");
    return s;
}

void CoreDAQ::arm_acquisition(int frames, bool use_trigger, bool trigger_rising) {
    check(coredaq_arm_acquisition(dev_, frames, use_trigger ? 1 : 0, trigger_rising ? 1 : 0), "arm_acquisition");
}

void CoreDAQ::start_acquisition() {
    check(coredaq_start_acquisition(dev_), "start_acquisition");
}

void CoreDAQ::stop_acquisition() {
    check(coredaq_stop_acquisition(dev_), "stop_acquisition");
}

void CoreDAQ::wait_for_completion(int timeout_ms, int poll_ms) {
    check(coredaq_wait_for_completion(dev_, timeout_ms, poll_ms), "wait_for_completion");
}

FrameBlock CoreDAQ::transfer_frames_mv(int frames, float log_deadband_mv) {
    FrameBlock fb;
    fb.ch1.resize(frames);
    fb.ch2.resize(frames);
    fb.ch3.resize(frames);
    fb.ch4.resize(frames);
    check(coredaq_transfer_frames_mv(dev_, frames, fb.ch1.data(), fb.ch2.data(), fb.ch3.data(), fb.ch4.data(), static_cast<size_t>(frames), log_deadband_mv), "transfer_frames_mv");
    return fb;
}

FrameBlock CoreDAQ::transfer_frames_volts(int frames, float log_deadband_mv) {
    FrameBlock fb;
    fb.ch1.resize(frames);
    fb.ch2.resize(frames);
    fb.ch3.resize(frames);
    fb.ch4.resize(frames);
    check(coredaq_transfer_frames_volts(dev_, frames, fb.ch1.data(), fb.ch2.data(), fb.ch3.data(), fb.ch4.data(), static_cast<size_t>(frames), log_deadband_mv), "transfer_frames_volts");
    return fb;
}

FrameBlock CoreDAQ::transfer_frames_w(int frames, float log_deadband_mv) {
    FrameBlock fb;
    fb.ch1.resize(frames);
    fb.ch2.resize(frames);
    fb.ch3.resize(frames);
    fb.ch4.resize(frames);
    check(coredaq_transfer_frames_w(dev_, frames, fb.ch1.data(), fb.ch2.data(), fb.ch3.data(), fb.ch4.data(), static_cast<size_t>(frames), log_deadband_mv), "transfer_frames_w");
    return fb;
}

std::vector<std::string> CoreDAQ::find_ports(int timeout_ms) {
    char ports[64][64] = {{0}};
    size_t count = 0;
    std::vector<std::string> out;
    coredaq_result_t rc = coredaq_find_ports(ports, 64, &count, timeout_ms);
    if (rc != COREDAQ_OK) {
        throw CoreDAQError("find_ports failed");
    }
    out.reserve(count);
    for (size_t i = 0; i < count; ++i) {
        out.emplace_back(ports[i]);
    }
    return out;
}

} // namespace coredaq
