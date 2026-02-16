#ifndef CALIB_H
#define CALIB_H

#include <stdint.h>

/* One gain calibration: mV = slope_mV_per_W * P(W) + intercept_mV */
typedef struct {
    float slope_mV_per_W;
    float intercept_mV;
} GainCal_t;

/* 4 heads, 8 gain levels each (0..7). */
#define CAL_NUM_HEADS  4u
#define CAL_NUM_GAINS  8u

extern const uint16_t factory_zero_adc[CAL_NUM_HEADS];

#ifdef __cplusplus
extern "C" {
#endif

/* Accessor: returns 1 on success, 0 on invalid head/gain */
int CAL_Get(uint8_t head, uint8_t gain,
            float *slope_mV_per_W,
            float *intercept_mV);

/* Optional: return pointer to struct (read-only) */
const GainCal_t *CAL_GetEntry(uint8_t head, uint8_t gain);

#ifdef __cplusplus
}
#endif

#endif /* CALIB_H */
