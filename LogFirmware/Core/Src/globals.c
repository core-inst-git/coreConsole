#include "globals.h"

EnvState  g_env  = {0.0f, 0.0f};
GainState g_gain = {{0,0,0,0}, 0, 0, 0};
volatile uint8_t g_i2c_refresh_request = 0;
volatile uint8_t g_acq_channel_mask = 0x0Fu;
