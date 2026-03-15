#include "coredaq_c_api.h"

#include <stdio.h>
#include <stdlib.h>

int main(int argc, char **argv) {
    const char *port = (argc > 1) ? argv[1] : "COM5";
    int frames = (argc > 2) ? atoi(argv[2]) : 2000;
    coredaq_device_t *dev = NULL;
    coredaq_result_t rc;
    int16_t *ch1 = NULL, *ch2 = NULL, *ch3 = NULL, *ch4 = NULL;
    int i;

    if (frames <= 0) {
        fprintf(stderr, "frames must be > 0\n");
        return 1;
    }

    rc = coredaq_create(&dev);
    if (rc != COREDAQ_OK) {
        fprintf(stderr, "create failed: %s\n", coredaq_result_string(rc));
        return 1;
    }

    rc = coredaq_open(dev, port, 115200, 300);
    if (rc != COREDAQ_OK) {
        fprintf(stderr, "open failed: %s (%s)\n", coredaq_result_string(rc), coredaq_last_error(dev));
        coredaq_destroy(dev);
        return 1;
    }

    rc = coredaq_set_channel_mask(dev, 0x0F);
    if (rc != COREDAQ_OK) {
        fprintf(stderr, "set channel mask failed: %s (%s)\n", coredaq_result_string(rc), coredaq_last_error(dev));
        coredaq_destroy(dev);
        return 1;
    }

    rc = coredaq_arm_acquisition(dev, frames, 1, 1);
    if (rc != COREDAQ_OK) {
        fprintf(stderr, "TRIGARM failed: %s (%s)\n", coredaq_result_string(rc), coredaq_last_error(dev));
        coredaq_destroy(dev);
        return 1;
    }

    printf("Armed for trigger. Waiting for completion...\n");
    rc = coredaq_wait_for_completion(dev, 20000, 50);
    if (rc != COREDAQ_OK) {
        fprintf(stderr, "wait failed: %s (%s)\n", coredaq_result_string(rc), coredaq_last_error(dev));
        coredaq_destroy(dev);
        return 1;
    }

    ch1 = (int16_t *)malloc((size_t)frames * sizeof(int16_t));
    ch2 = (int16_t *)malloc((size_t)frames * sizeof(int16_t));
    ch3 = (int16_t *)malloc((size_t)frames * sizeof(int16_t));
    ch4 = (int16_t *)malloc((size_t)frames * sizeof(int16_t));
    if (!ch1 || !ch2 || !ch3 || !ch4) {
        fprintf(stderr, "allocation failed\n");
        free(ch1); free(ch2); free(ch3); free(ch4);
        coredaq_destroy(dev);
        return 1;
    }

    rc = coredaq_transfer_frames_adc(dev, frames, ch1, ch2, ch3, ch4, (size_t)frames);
    if (rc != COREDAQ_OK) {
        fprintf(stderr, "transfer failed: %s (%s)\n", coredaq_result_string(rc), coredaq_last_error(dev));
        free(ch1); free(ch2); free(ch3); free(ch4);
        coredaq_destroy(dev);
        return 1;
    }

    printf("Transfer complete. First 8 samples:\n");
    for (i = 0; i < frames && i < 8; i += 1) {
        printf("%5d: %6d %6d %6d %6d\n", i, ch1[i], ch2[i], ch3[i], ch4[i]);
    }

    free(ch1); free(ch2); free(ch3); free(ch4);
    coredaq_destroy(dev);
    return 0;
}
