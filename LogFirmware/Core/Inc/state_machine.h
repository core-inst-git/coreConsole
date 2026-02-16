#pragma once
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
    STATE_IDLE = 0,            // nothing armed/running
    STATE_ARMED,               // armed for immediate START
    STATE_ARMED_WAIT_TRIGGER,	// armed; waiting for external trigger
    STATE_ACQ_ACTIVE,          // streaming frames
    STATE_DATA_READY,          // finished; data in SDRAM
    STATE_TRANSFER,            // <--- NEW: bulk USB transfer in progress
    STATE_ERROR,
	STATE_CAL_DUMP
// fault state (optional)
} SystemState;

/* API */
void        SM_Init(void);
void        SM_SetState(SystemState s);
SystemState SM_GetState(void);
const char* SM_GetStateName(SystemState s);

/* NEW: only valid from DATA_READY; returns 1 on success, 0 otherwise */
uint8_t     SM_RequestTransfer(void);

/* convenience */
static inline uint8_t SM_IsIdle(void)              { return SM_GetState()==STATE_IDLE; }
static inline uint8_t SM_IsArmed(void)             { return SM_GetState()==STATE_ARMED; }
static inline uint8_t SM_IsArmedWaitTrig(void)     { return SM_GetState()==STATE_ARMED_WAIT_TRIGGER; }
static inline uint8_t SM_IsAcqActive(void)         { return SM_GetState()==STATE_ACQ_ACTIVE; }
static inline uint8_t SM_IsDataReady(void)         { return SM_GetState()==STATE_DATA_READY; }
static inline uint8_t SM_IsTransfer(void)          { return SM_GetState()==STATE_TRANSFER; } // <--- NEW

#ifdef __cplusplus
}
#endif
