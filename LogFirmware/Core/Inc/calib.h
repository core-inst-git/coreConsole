#pragma once
#include <stdint.h>

#define CAL_NUM_HEADS 4

typedef struct __attribute__((packed)) {
    uint16_t V_mV;        // LUT x-axis (mV)
    int32_t  log10P_Q16;  // LUT y-axis (log10(P[W]) * 65536)
} LogLutPt_t;

typedef struct {
    const LogLutPt_t *pts;
    uint16_t n_pts;
} LogLut_t;

int LOGCAL_GetLUT(uint8_t head, LogLut_t *out);

// --- CAL DUMP streaming interface ---
void CALDUMP_Start(uint8_t head);
void CALDUMP_Task(void);
uint8_t CALDUMP_IsActive(void);
