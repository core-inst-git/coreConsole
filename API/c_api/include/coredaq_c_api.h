#ifndef COREDAQ_C_API_H
#define COREDAQ_C_API_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define COREDAQ_NUM_HEADS 4
#define COREDAQ_NUM_GAINS 8
#define COREDAQ_ADC_BITS 16
#define COREDAQ_ADC_VFS_VOLTS 5.0
#define COREDAQ_ADC_LSB_VOLTS ((2.0 * COREDAQ_ADC_VFS_VOLTS) / (1u << COREDAQ_ADC_BITS))
#define COREDAQ_ADC_LSB_MV (COREDAQ_ADC_LSB_VOLTS * 1e3)

typedef enum coredaq_result {
    COREDAQ_OK = 0,
    COREDAQ_ERR_INVALID_ARG = -1,
    COREDAQ_ERR_IO = -2,
    COREDAQ_ERR_TIMEOUT = -3,
    COREDAQ_ERR_PROTOCOL = -4,
    COREDAQ_ERR_BUSY = -5,
    COREDAQ_ERR_DEVICE = -6,
    COREDAQ_ERR_NO_MEMORY = -7,
    COREDAQ_ERR_NOT_OPEN = -8,
    COREDAQ_ERR_UNSUPPORTED = -9
} coredaq_result_t;

typedef struct coredaq_device coredaq_device_t;

const char *coredaq_result_string(coredaq_result_t rc);

coredaq_result_t coredaq_create(coredaq_device_t **out_dev);
void coredaq_destroy(coredaq_device_t *dev);

coredaq_result_t coredaq_open(coredaq_device_t *dev, const char *port, int baudrate, int timeout_ms);
void coredaq_close(coredaq_device_t *dev);
int coredaq_is_open(const coredaq_device_t *dev);

const char *coredaq_last_error(const coredaq_device_t *dev);

coredaq_result_t coredaq_set_inter_command_gap_ms(coredaq_device_t *dev, int gap_ms);
coredaq_result_t coredaq_get_inter_command_gap_ms(const coredaq_device_t *dev, int *out_gap_ms);

coredaq_result_t coredaq_query(coredaq_device_t *dev, const char *cmd, char *out_payload, size_t out_payload_len);
coredaq_result_t coredaq_write(coredaq_device_t *dev, const char *cmd);

coredaq_result_t coredaq_idn(coredaq_device_t *dev, char *out_idn, size_t out_idn_len);
coredaq_result_t coredaq_frontend_type(coredaq_device_t *dev, char *out_type, size_t out_type_len);

coredaq_result_t coredaq_get_gains(coredaq_device_t *dev, int out_gains[COREDAQ_NUM_HEADS]);
coredaq_result_t coredaq_set_gain(coredaq_device_t *dev, int head_1_to_4, int gain_0_to_7);

coredaq_result_t coredaq_get_freq_hz(coredaq_device_t *dev, int *out_hz);
coredaq_result_t coredaq_set_freq_hz(coredaq_device_t *dev, int hz);

coredaq_result_t coredaq_get_oversampling(coredaq_device_t *dev, int *out_os_idx);
coredaq_result_t coredaq_set_oversampling(coredaq_device_t *dev, int os_idx);

coredaq_result_t coredaq_get_channel_mask_info(coredaq_device_t *dev, int *out_mask, int *out_active_channels, int *out_frame_bytes);
coredaq_result_t coredaq_get_channel_mask(coredaq_device_t *dev, int *out_mask);
coredaq_result_t coredaq_set_channel_mask(coredaq_device_t *dev, int mask);

coredaq_result_t coredaq_refresh_factory_zeros(coredaq_device_t *dev, int out_factory_zeros[COREDAQ_NUM_HEADS]);
coredaq_result_t coredaq_get_linear_zero_adc(coredaq_device_t *dev, int out_zero_adc[COREDAQ_NUM_HEADS]);
coredaq_result_t coredaq_set_soft_zero_adc(coredaq_device_t *dev, const int zero_adc[COREDAQ_NUM_HEADS]);
coredaq_result_t coredaq_restore_factory_zero(coredaq_device_t *dev);

coredaq_result_t coredaq_load_linear_calibration(coredaq_device_t *dev);
coredaq_result_t coredaq_load_log_calibration(coredaq_device_t *dev);

coredaq_result_t coredaq_snapshot_adc(
    coredaq_device_t *dev,
    int n_frames,
    int timeout_ms,
    int poll_hz,
    int out_codes[COREDAQ_NUM_HEADS],
    int out_gains[COREDAQ_NUM_HEADS]
);

coredaq_result_t coredaq_snapshot_adc_zeroed(
    coredaq_device_t *dev,
    int n_frames,
    int timeout_ms,
    int poll_hz,
    int out_codes[COREDAQ_NUM_HEADS],
    int out_gains[COREDAQ_NUM_HEADS]
);

coredaq_result_t coredaq_snapshot_mv(
    coredaq_device_t *dev,
    int n_frames,
    int timeout_ms,
    int poll_hz,
    float out_mv[COREDAQ_NUM_HEADS],
    int out_gains[COREDAQ_NUM_HEADS]
);

coredaq_result_t coredaq_snapshot_volts(
    coredaq_device_t *dev,
    int n_frames,
    int timeout_ms,
    int poll_hz,
    float out_volts[COREDAQ_NUM_HEADS],
    int out_gains[COREDAQ_NUM_HEADS]
);

coredaq_result_t coredaq_snapshot_w(
    coredaq_device_t *dev,
    int n_frames,
    int timeout_ms,
    int poll_hz,
    float log_deadband_mv,
    float out_w[COREDAQ_NUM_HEADS],
    int out_gains[COREDAQ_NUM_HEADS]
);

coredaq_result_t coredaq_state_enum(coredaq_device_t *dev, int *out_state);
coredaq_result_t coredaq_arm_acquisition(coredaq_device_t *dev, int frames, int use_trigger, int trigger_rising);
coredaq_result_t coredaq_start_acquisition(coredaq_device_t *dev);
coredaq_result_t coredaq_stop_acquisition(coredaq_device_t *dev);
coredaq_result_t coredaq_frames_remaining(coredaq_device_t *dev, int *out_frames_left);
coredaq_result_t coredaq_wait_for_completion(coredaq_device_t *dev, int timeout_ms, int poll_ms);

coredaq_result_t coredaq_transfer_frames_adc_interleaved(
    coredaq_device_t *dev,
    int frames,
    int16_t *out_samples,
    size_t out_sample_count,
    int *out_mask,
    int *out_active_channels
);

coredaq_result_t coredaq_transfer_frames_adc(
    coredaq_device_t *dev,
    int frames,
    int16_t *ch1,
    int16_t *ch2,
    int16_t *ch3,
    int16_t *ch4,
    size_t per_channel_len
);

coredaq_result_t coredaq_transfer_frames_mv(
    coredaq_device_t *dev,
    int frames,
    float *ch1,
    float *ch2,
    float *ch3,
    float *ch4,
    size_t per_channel_len,
    float log_deadband_mv
);

coredaq_result_t coredaq_transfer_frames_volts(
    coredaq_device_t *dev,
    int frames,
    float *ch1,
    float *ch2,
    float *ch3,
    float *ch4,
    size_t per_channel_len,
    float log_deadband_mv
);

coredaq_result_t coredaq_transfer_frames_w(
    coredaq_device_t *dev,
    int frames,
    float *ch1,
    float *ch2,
    float *ch3,
    float *ch4,
    size_t per_channel_len,
    float log_deadband_mv
);

coredaq_result_t coredaq_stream_write_address(coredaq_device_t *dev, int *out_addr);
coredaq_result_t coredaq_soft_reset(coredaq_device_t *dev);
coredaq_result_t coredaq_i2c_refresh(coredaq_device_t *dev);

coredaq_result_t coredaq_get_head_temperature_c(coredaq_device_t *dev, double *out_temp_c);
coredaq_result_t coredaq_get_head_humidity_pct(coredaq_device_t *dev, double *out_humidity_pct);
coredaq_result_t coredaq_get_die_temperature_c(coredaq_device_t *dev, double *out_temp_c);

coredaq_result_t coredaq_find_ports(char out_ports[][64], size_t max_ports, size_t *out_count, int timeout_ms);

#ifdef __cplusplus
}
#endif

#endif