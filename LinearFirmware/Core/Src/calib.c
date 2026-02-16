#include "calib.h"

/*
 * Calibration table:
 *   cal_table[head-1][gain]
 *
 * Replace the example values with your real calibration
 * (slope in mV/W, intercept in mV).
 */

const uint16_t factory_zero_adc[CAL_NUM_HEADS] = {
	874, 874, 876, 873
};

static const GainCal_t cal_table[CAL_NUM_HEADS][CAL_NUM_GAINS] = {

    /* ================= HEAD 1 (CH1) ================= */
    {
        {9.677719e5f,   -2.559920e0f},   // gain 0
        {4.543134e6f,   -9.481616e0f},   // gain 1
        {9.556015e6f,   -4.194786e0f},   // gain 2
        {4.488325e7f,   -4.829061e0f},   // gain 3
        {9.552275e7f,   -5.183598e0f},   // gain 4
        {4.507265e8f,   -4.696475e0f},   // gain 5
        {9.539802e8f,   -4.322497e0f},   // gain 6
        {9.571939e9f,   -3.701124e0f},   // gain 7
    },

    /* ================= HEAD 2 (CH2) ================= */
    {
        {1.004399e6f,   -3.448882e0f},   // gain 0
        {4.714491e6f,   -9.417843e0f},   // gain 1
        {9.937062e6f,   -5.258261e0f},   // gain 2
        {4.663927e7f,   -4.999548e0f},   // gain 3
        {9.923365e7f,   -5.283329e0f},   // gain 4
        {4.662405e8f,   -4.902696e0f},   // gain 5
        {9.927836e8f,   -5.121995e0f},   // gain 6
        {9.988720e9f,   -3.444520e0f},   // gain 7
    },

    /* ================= HEAD 3 (CH3) ================= */
    {
        {8.936864e5f,   -2.476429e0f},   // gain 0
        {4.198294e6f,   -7.858964e0f},   // gain 1
        {8.869844e6f,   -5.211314e0f},   // gain 2
        {4.159802e7f,   -4.006313e0f},   // gain 3
        {8.866985e7f,   -5.134499e0f},   // gain 4
        {4.162381e8f,   -4.779144e0f},   // gain 5
        {8.864482e8f,   -4.834041e0f},   // gain 6
        {8.898587e9f,   -4.524130e0f},   // gain 7
    },

    /* ================= HEAD 4 (CH4) ================= */
    {
        {8.633395e5f,   -3.437177e0f},   // gain 0
        {4.046023e6f,   -7.883741e0f},   // gain 1
        {8.553438e6f,   -5.533643e0f},   // gain 2
        {4.015310e7f,   -5.262158e0f},   // gain 3
        {8.552410e7f,   -6.034507e0f},   // gain 4
        {4.005991e8f,   -4.792502e0f},   // gain 5
        {8.537944e8f,   -4.751197e0f},   // gain 6
        {8.541253e9f,   -3.567952e0f},   // gain 7
    }
};

int CAL_Get(uint8_t head, uint8_t gain,
            float *slope_mV_per_W,
            float *intercept_mV)
{
    if (head == 0u || head > CAL_NUM_HEADS) return 0;
    if (gain >= CAL_NUM_GAINS) return 0;

    const GainCal_t *g = &cal_table[head - 1u][gain];

    if (slope_mV_per_W) *slope_mV_per_W = g->slope_mV_per_W;
    if (intercept_mV)   *intercept_mV   = g->intercept_mV;
    return 1;
}

const GainCal_t *CAL_GetEntry(uint8_t head, uint8_t gain)
{
    if (head == 0u || head > CAL_NUM_HEADS) return 0;
    if (gain >= CAL_NUM_GAINS) return 0;
    return &cal_table[head - 1u][gain];
}
