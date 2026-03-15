#include "coredaq_c_api.h"

#include <stdio.h>
#include <stdlib.h>

int main(int argc, char **argv) {
    const char *port = (argc > 1) ? argv[1] : "COM5";
    coredaq_device_t *dev = NULL;
    coredaq_result_t rc;
    char idn[256];
    char frontend[32];
    float power_w[4];
    int gains[4];
    int i;

    rc = coredaq_create(&dev);
    if (rc != COREDAQ_OK) {
        fprintf(stderr, "create failed: %s\n", coredaq_result_string(rc));
        return 1;
    }

    rc = coredaq_open(dev, port, 115200, 200);
    if (rc != COREDAQ_OK) {
        fprintf(stderr, "open failed: %s (%s)\n", coredaq_result_string(rc), coredaq_last_error(dev));
        coredaq_destroy(dev);
        return 1;
    }

    coredaq_idn(dev, idn, sizeof(idn));
    coredaq_frontend_type(dev, frontend, sizeof(frontend));
    printf("IDN: %s\n", idn);
    printf("Frontend: %s\n", frontend);

    rc = coredaq_snapshot_w(dev, 1, 1200, 200, 300.0f, power_w, gains);
    if (rc != COREDAQ_OK) {
        fprintf(stderr, "snapshot_w failed: %s (%s)\n", coredaq_result_string(rc), coredaq_last_error(dev));
        coredaq_destroy(dev);
        return 1;
    }

    for (i = 0; i < 4; i += 1) {
        printf("CH%d: %.9f W  (gain=%d)\n", i + 1, power_w[i], gains[i]);
    }

    coredaq_destroy(dev);
    return 0;
}
