#include "state_machine.h"
#include "leds.h"

/* volatile because ISR and main thread touch it */
static volatile SystemState g_state = STATE_IDLE;

void SM_Init(void) {
    g_state = STATE_IDLE;
}

void SM_SetState(SystemState s) {
    g_state = s;
}

SystemState SM_GetState(void) {
    return g_state;
}

/* NEW: guarded transition into TRANSFER */
uint8_t SM_RequestTransfer(void)
{
    if (g_state != STATE_DATA_READY) return 0;
    g_state = STATE_TRANSFER;
    LED3_BlinkStart(10, 0.5f);   // 10 Hz, 50% duty
    return 1;

}

const char* SM_GetStateName(SystemState s) {
    switch (s) {
        case STATE_IDLE:               return "IDLE";
        case STATE_ARMED:              return "ARMED";
        case STATE_ARMED_WAIT_TRIGGER: return "ARMED_WAIT_TRIGGER";
        case STATE_ACQ_ACTIVE:         return "ACQ_ACTIVE";
        case STATE_DATA_READY:         return "DATA_READY";
        case STATE_TRANSFER:           return "TRANSFER";      // <--- NEW
        case STATE_ERROR:              return "ERROR";
        default:                       return "UNKNOWN";
    }
}
