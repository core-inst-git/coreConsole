
#include "coredaq_c_api.h"

#include <ctype.h>
#include <errno.h>
#include <math.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#else
#include <fcntl.h>
#include <glob.h>
#include <sys/select.h>
#include <termios.h>
#include <time.h>
#include <unistd.h>
#endif

#if !defined(_WIN32)
#define STRNICMP strncasecmp
#else
#define STRNICMP _strnicmp
#endif

struct coredaq_device {
#ifdef _WIN32
    HANDLE h;
#else
    int fd;
#endif
    int is_open;
    int timeout_ms;
    int write_timeout_ms;
    int inter_gap_ms;
    unsigned long long last_cmd_ms;

    char port[64];
    char idn_cache[256];
    char frontend[16];
    char last_error[512];

    int factory_zero_adc[COREDAQ_NUM_HEADS];
    int linear_zero_adc[COREDAQ_NUM_HEADS];

    float cal_slope[COREDAQ_NUM_HEADS][COREDAQ_NUM_GAINS];
    float cal_intercept[COREDAQ_NUM_HEADS][COREDAQ_NUM_GAINS];
    int linear_cal_loaded;

    int log_n[COREDAQ_NUM_HEADS];
    double *log_v[COREDAQ_NUM_HEADS];
    double *log_log10p[COREDAQ_NUM_HEADS];
    int log_cal_loaded;

    float log_deadband_mv;
};

static void set_error(coredaq_device_t *dev, const char *fmt, ...) {
    va_list ap;
    if (!dev) {
        return;
    }
    va_start(ap, fmt);
    vsnprintf(dev->last_error, sizeof(dev->last_error), fmt, ap);
    va_end(ap);
}

static void clear_error(coredaq_device_t *dev) {
    if (dev) {
        dev->last_error[0] = '\0';
    }
}

static unsigned long long now_ms(void) {
#ifdef _WIN32
    return (unsigned long long)GetTickCount64();
#else
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (unsigned long long)ts.tv_sec * 1000ULL + (unsigned long long)ts.tv_nsec / 1000000ULL;
#endif
}

static void sleep_ms(int ms) {
    if (ms <= 0) {
        return;
    }
#ifdef _WIN32
    Sleep((DWORD)ms);
#else
    struct timespec req;
    req.tv_sec = ms / 1000;
    req.tv_nsec = (long)(ms % 1000) * 1000000L;
    nanosleep(&req, NULL);
#endif
}

static void trim(char *s) {
    size_t len;
    if (!s) return;
    while (*s && isspace((unsigned char)*s)) {
        memmove(s, s + 1, strlen(s));
    }
    len = strlen(s);
    while (len > 0 && isspace((unsigned char)s[len - 1])) {
        s[--len] = '\0';
    }
}

static int contains_case_insensitive(const char *hay, const char *needle) {
    size_t nh, nn, i;
    if (!hay || !needle) return 0;
    nh = strlen(hay);
    nn = strlen(needle);
    if (nn == 0 || nn > nh) return 0;
    for (i = 0; i + nn <= nh; i += 1) {
        size_t j = 0;
        while (j < nn) {
            char a = (char)tolower((unsigned char)hay[i + j]);
            char b = (char)tolower((unsigned char)needle[j]);
            if (a != b) break;
            j += 1;
        }
        if (j == nn) return 1;
    }
    return 0;
}

static int active_indices_from_mask(int mask, int out_idx[COREDAQ_NUM_HEADS]) {
    int count = 0;
    int i;
    for (i = 0; i < COREDAQ_NUM_HEADS; i += 1) {
        if (((mask >> i) & 1) != 0) {
            if (out_idx) out_idx[count] = i;
            count += 1;
        }
    }
    return count;
}

#ifdef _WIN32
static coredaq_result_t serial_open(coredaq_device_t *dev, const char *port, int baudrate) {
    char device_path[96];
    DCB dcb;
    COMMTIMEOUTS tm;

    snprintf(device_path, sizeof(device_path), "\\\\.\\%s", port);
    dev->h = CreateFileA(device_path, GENERIC_READ | GENERIC_WRITE, 0, NULL, OPEN_EXISTING, 0, NULL);
    if (dev->h == INVALID_HANDLE_VALUE) {
        set_error(dev, "CreateFile failed for %s", device_path);
        return COREDAQ_ERR_IO;
    }

    memset(&dcb, 0, sizeof(dcb));
    dcb.DCBlength = sizeof(dcb);
    if (!GetCommState(dev->h, &dcb)) {
        set_error(dev, "GetCommState failed");
        CloseHandle(dev->h);
        dev->h = INVALID_HANDLE_VALUE;
        return COREDAQ_ERR_IO;
    }
    dcb.BaudRate = (DWORD)((baudrate > 0) ? baudrate : 115200);
    dcb.ByteSize = 8;
    dcb.Parity = NOPARITY;
    dcb.StopBits = ONESTOPBIT;
    dcb.fBinary = TRUE;

    if (!SetCommState(dev->h, &dcb)) {
        set_error(dev, "SetCommState failed");
        CloseHandle(dev->h);
        dev->h = INVALID_HANDLE_VALUE;
        return COREDAQ_ERR_IO;
    }

    memset(&tm, 0, sizeof(tm));
    tm.ReadIntervalTimeout = 10;
    tm.ReadTotalTimeoutConstant = (DWORD)((dev->timeout_ms > 0) ? dev->timeout_ms : 150);
    tm.WriteTotalTimeoutConstant = (DWORD)((dev->write_timeout_ms > 0) ? dev->write_timeout_ms : 500);
    if (!SetCommTimeouts(dev->h, &tm)) {
        set_error(dev, "SetCommTimeouts failed");
        CloseHandle(dev->h);
        dev->h = INVALID_HANDLE_VALUE;
        return COREDAQ_ERR_IO;
    }
    SetupComm(dev->h, 1 << 16, 1 << 16);
    PurgeComm(dev->h, PURGE_RXCLEAR | PURGE_TXCLEAR);
    return COREDAQ_OK;
}

static void serial_close(coredaq_device_t *dev) {
    if (dev && dev->h != INVALID_HANDLE_VALUE) {
        CloseHandle(dev->h);
        dev->h = INVALID_HANDLE_VALUE;
    }
}

static coredaq_result_t serial_flush_rx(coredaq_device_t *dev) {
    if (!PurgeComm(dev->h, PURGE_RXCLEAR)) {
        set_error(dev, "PurgeComm failed");
        return COREDAQ_ERR_IO;
    }
    return COREDAQ_OK;
}

static coredaq_result_t serial_write_all(coredaq_device_t *dev, const unsigned char *buf, size_t len) {
    size_t done = 0;
    while (done < len) {
        DWORD wr = 0;
        if (!WriteFile(dev->h, buf + done, (DWORD)(len - done), &wr, NULL)) {
            set_error(dev, "WriteFile failed");
            return COREDAQ_ERR_IO;
        }
        if (wr == 0) {
            sleep_ms(1);
            continue;
        }
        done += (size_t)wr;
    }
    return COREDAQ_OK;
}

static coredaq_result_t serial_read_some(coredaq_device_t *dev, unsigned char *buf, size_t cap, size_t *out_n, int timeout_ms) {
    unsigned long long deadline = now_ms() + (unsigned long long)((timeout_ms > 0) ? timeout_ms : dev->timeout_ms);
    *out_n = 0;
    while (now_ms() <= deadline) {
        DWORD rd = 0;
        if (!ReadFile(dev->h, buf, (DWORD)cap, &rd, NULL)) {
            set_error(dev, "ReadFile failed");
            return COREDAQ_ERR_IO;
        }
        if (rd > 0) {
            *out_n = (size_t)rd;
            return COREDAQ_OK;
        }
        sleep_ms(1);
    }
    return COREDAQ_ERR_TIMEOUT;
}
#else
static speed_t to_baud(int baudrate) {
    switch (baudrate) {
        case 9600: return B9600;
        case 19200: return B19200;
        case 38400: return B38400;
        case 57600: return B57600;
        case 230400: return B230400;
#ifdef B460800
        case 460800: return B460800;
#endif
#ifdef B921600
        case 921600: return B921600;
#endif
        case 115200:
        default: return B115200;
    }
}

static coredaq_result_t serial_open(coredaq_device_t *dev, const char *port, int baudrate) {
    struct termios tio;
    dev->fd = open(port, O_RDWR | O_NOCTTY);
    if (dev->fd < 0) {
        set_error(dev, "open(%s) failed: %s", port, strerror(errno));
        return COREDAQ_ERR_IO;
    }
    if (tcgetattr(dev->fd, &tio) != 0) {
        set_error(dev, "tcgetattr failed: %s", strerror(errno));
        close(dev->fd);
        dev->fd = -1;
        return COREDAQ_ERR_IO;
    }
    cfmakeraw(&tio);
    cfsetispeed(&tio, to_baud(baudrate));
    cfsetospeed(&tio, to_baud(baudrate));
    tio.c_cflag |= CLOCAL | CREAD;
    tio.c_cflag &= ~(PARENB | CSTOPB | CSIZE);
    tio.c_cflag |= CS8;
    tio.c_cc[VMIN] = 0;
    tio.c_cc[VTIME] = 0;
    if (tcsetattr(dev->fd, TCSANOW, &tio) != 0) {
        set_error(dev, "tcsetattr failed: %s", strerror(errno));
        close(dev->fd);
        dev->fd = -1;
        return COREDAQ_ERR_IO;
    }
    tcflush(dev->fd, TCIOFLUSH);
    return COREDAQ_OK;
}
static void serial_close(coredaq_device_t *dev) {
    if (dev && dev->fd >= 0) {
        close(dev->fd);
        dev->fd = -1;
    }
}

static coredaq_result_t serial_flush_rx(coredaq_device_t *dev) {
    if (tcflush(dev->fd, TCIFLUSH) != 0) {
        set_error(dev, "tcflush failed: %s", strerror(errno));
        return COREDAQ_ERR_IO;
    }
    return COREDAQ_OK;
}

static coredaq_result_t serial_write_all(coredaq_device_t *dev, const unsigned char *buf, size_t len) {
    size_t done = 0;
    while (done < len) {
        ssize_t wr = write(dev->fd, buf + done, len - done);
        if (wr < 0) {
            if (errno == EINTR) continue;
            set_error(dev, "write failed: %s", strerror(errno));
            return COREDAQ_ERR_IO;
        }
        if (wr == 0) {
            sleep_ms(1);
            continue;
        }
        done += (size_t)wr;
    }
    tcdrain(dev->fd);
    return COREDAQ_OK;
}

static coredaq_result_t serial_read_some(coredaq_device_t *dev, unsigned char *buf, size_t cap, size_t *out_n, int timeout_ms) {
    fd_set rfds;
    struct timeval tv;
    int rv;
    ssize_t rd;
    *out_n = 0;

    FD_ZERO(&rfds);
    FD_SET(dev->fd, &rfds);
    tv.tv_sec = (timeout_ms > 0 ? timeout_ms : dev->timeout_ms) / 1000;
    tv.tv_usec = ((timeout_ms > 0 ? timeout_ms : dev->timeout_ms) % 1000) * 1000;
    rv = select(dev->fd + 1, &rfds, NULL, NULL, &tv);
    if (rv < 0) {
        if (errno == EINTR) return COREDAQ_ERR_TIMEOUT;
        set_error(dev, "select failed: %s", strerror(errno));
        return COREDAQ_ERR_IO;
    }
    if (rv == 0) {
        return COREDAQ_ERR_TIMEOUT;
    }
    rd = read(dev->fd, buf, cap);
    if (rd < 0) {
        if (errno == EINTR) return COREDAQ_ERR_TIMEOUT;
        set_error(dev, "read failed: %s", strerror(errno));
        return COREDAQ_ERR_IO;
    }
    if (rd == 0) {
        return COREDAQ_ERR_TIMEOUT;
    }
    *out_n = (size_t)rd;
    return COREDAQ_OK;
}
#endif

static coredaq_result_t ensure_open(coredaq_device_t *dev) {
    if (!dev) return COREDAQ_ERR_INVALID_ARG;
    if (!dev->is_open) {
        set_error(dev, "Device is not open");
        return COREDAQ_ERR_NOT_OPEN;
    }
    return COREDAQ_OK;
}

static coredaq_result_t apply_gap(coredaq_device_t *dev) {
    if (dev->inter_gap_ms > 0 && dev->last_cmd_ms > 0) {
        unsigned long long now = now_ms();
        unsigned long long need = dev->last_cmd_ms + (unsigned long long)dev->inter_gap_ms;
        if (now < need) {
            sleep_ms((int)(need - now));
        }
    }
    return COREDAQ_OK;
}

static coredaq_result_t write_line(coredaq_device_t *dev, const char *line) {
    char cmd[256];
    if (!dev || !line) return COREDAQ_ERR_INVALID_ARG;
    if (strlen(line) + 2 >= sizeof(cmd)) {
        set_error(dev, "Command too long");
        return COREDAQ_ERR_INVALID_ARG;
    }
    snprintf(cmd, sizeof(cmd), "%s\n", line);
    apply_gap(dev);
    {
        coredaq_result_t rc = serial_write_all(dev, (const unsigned char *)cmd, strlen(cmd));
        if (rc == COREDAQ_OK) {
            dev->last_cmd_ms = now_ms();
        }
        return rc;
    }
}

static coredaq_result_t read_line(coredaq_device_t *dev, char *out, size_t out_len, int timeout_ms) {
    unsigned long long deadline;
    size_t used = 0;
    if (!dev || !out || out_len < 2) return COREDAQ_ERR_INVALID_ARG;
    out[0] = '\0';
    deadline = now_ms() + (unsigned long long)((timeout_ms > 0) ? timeout_ms : dev->timeout_ms);

    while (now_ms() <= deadline) {
        unsigned char c = 0;
        size_t got = 0;
        coredaq_result_t rc = serial_read_some(dev, &c, 1, &got, 20);
        if (rc == COREDAQ_ERR_TIMEOUT) continue;
        if (rc != COREDAQ_OK) return rc;
        if (got == 0) continue;
        if (c == '\n') break;
        if (c == '\r') continue;
        if (used + 1 >= out_len) {
            set_error(dev, "Line too long");
            return COREDAQ_ERR_PROTOCOL;
        }
        out[used++] = (char)c;
        out[used] = '\0';
    }

    if (used == 0) return COREDAQ_ERR_TIMEOUT;
    trim(out);
    return COREDAQ_OK;
}

static coredaq_result_t read_status_payload(coredaq_device_t *dev, char *payload, size_t payload_len) {
    char line[512];
    coredaq_result_t rc = read_line(dev, line, sizeof(line), dev->timeout_ms);
    if (rc != COREDAQ_OK) {
        set_error(dev, "Timed out waiting for response");
        return rc;
    }
    if (strncmp(line, "OK", 2) == 0) {
        const char *p = line + 2;
        while (*p && isspace((unsigned char)*p)) p += 1;
        if (payload && payload_len > 0) snprintf(payload, payload_len, "%s", p);
        return COREDAQ_OK;
    }
    if (strncmp(line, "BUSY", 4) == 0) {
        if (payload && payload_len > 0) payload[0] = '\0';
        return COREDAQ_ERR_BUSY;
    }
    if (strncmp(line, "ERR", 3) == 0) {
        const char *p = line + 3;
        while (*p && isspace((unsigned char)*p)) p += 1;
        set_error(dev, "Device error: %s", p);
        if (payload && payload_len > 0) snprintf(payload, payload_len, "%s", p);
        return COREDAQ_ERR_DEVICE;
    }
    set_error(dev, "Unexpected response: %s", line);
    return COREDAQ_ERR_PROTOCOL;
}

static coredaq_result_t query_internal(coredaq_device_t *dev, const char *cmd, char *payload, size_t payload_len) {
    coredaq_result_t rc = write_line(dev, cmd);
    if (rc != COREDAQ_OK) return rc;
    return read_status_payload(dev, payload, payload_len);
}

static coredaq_result_t detect_frontend(coredaq_device_t *dev) {
    char payload[128];
    coredaq_result_t rc = query_internal(dev, "HEAD_TYPE?", payload, sizeof(payload));
    if (rc != COREDAQ_OK) return rc;
    if (contains_case_insensitive(payload, "TYPE=LINEAR") || contains_case_insensitive(payload, "LINEAR")) {
        snprintf(dev->frontend, sizeof(dev->frontend), "LINEAR");
        return COREDAQ_OK;
    }
    if (contains_case_insensitive(payload, "TYPE=LOG") || contains_case_insensitive(payload, "LOG")) {
        snprintf(dev->frontend, sizeof(dev->frontend), "LOG");
        return COREDAQ_OK;
    }
    set_error(dev, "Unknown HEAD_TYPE payload: %s", payload);
    return COREDAQ_ERR_PROTOCOL;
}

const char *coredaq_result_string(coredaq_result_t rc) {
    switch (rc) {
        case COREDAQ_OK: return "COREDAQ_OK";
        case COREDAQ_ERR_INVALID_ARG: return "COREDAQ_ERR_INVALID_ARG";
        case COREDAQ_ERR_IO: return "COREDAQ_ERR_IO";
        case COREDAQ_ERR_TIMEOUT: return "COREDAQ_ERR_TIMEOUT";
        case COREDAQ_ERR_PROTOCOL: return "COREDAQ_ERR_PROTOCOL";
        case COREDAQ_ERR_BUSY: return "COREDAQ_ERR_BUSY";
        case COREDAQ_ERR_DEVICE: return "COREDAQ_ERR_DEVICE";
        case COREDAQ_ERR_NO_MEMORY: return "COREDAQ_ERR_NO_MEMORY";
        case COREDAQ_ERR_NOT_OPEN: return "COREDAQ_ERR_NOT_OPEN";
        case COREDAQ_ERR_UNSUPPORTED: return "COREDAQ_ERR_UNSUPPORTED";
        default: return "COREDAQ_ERR_UNKNOWN";
    }
}

coredaq_result_t coredaq_create(coredaq_device_t **out_dev) {
    coredaq_device_t *dev;
    if (!out_dev) return COREDAQ_ERR_INVALID_ARG;
    *out_dev = NULL;
    dev = (coredaq_device_t *)calloc(1, sizeof(coredaq_device_t));
    if (!dev) return COREDAQ_ERR_NO_MEMORY;
#ifdef _WIN32
    dev->h = INVALID_HANDLE_VALUE;
#else
    dev->fd = -1;
#endif
    dev->timeout_ms = 150;
    dev->write_timeout_ms = 500;
    dev->log_deadband_mv = 300.0f;
    snprintf(dev->frontend, sizeof(dev->frontend), "UNKNOWN");
    *out_dev = dev;
    return COREDAQ_OK;
}

void coredaq_destroy(coredaq_device_t *dev) {
    int i;
    if (!dev) return;
    coredaq_close(dev);
    for (i = 0; i < COREDAQ_NUM_HEADS; i += 1) {
        free(dev->log_v[i]);
        free(dev->log_log10p[i]);
    }
    free(dev);
}
coredaq_result_t coredaq_open(coredaq_device_t *dev, const char *port, int baudrate, int timeout_ms) {
    coredaq_result_t rc;
    int i;
    if (!dev || !port || !*port) return COREDAQ_ERR_INVALID_ARG;

    coredaq_close(dev);

    dev->timeout_ms = (timeout_ms > 0) ? timeout_ms : 150;
    dev->write_timeout_ms = (dev->timeout_ms > 500) ? dev->timeout_ms : 500;
    snprintf(dev->port, sizeof(dev->port), "%s", port);

    rc = serial_open(dev, port, (baudrate > 0) ? baudrate : 115200);
    if (rc != COREDAQ_OK) return rc;

    dev->is_open = 1;
    clear_error(dev);
    serial_flush_rx(dev);
    sleep_ms(20);

    rc = detect_frontend(dev);
    if (rc != COREDAQ_OK) {
        coredaq_close(dev);
        return rc;
    }

    {
        char payload[256];
        rc = query_internal(dev, "IDN?", payload, sizeof(payload));
        if (rc != COREDAQ_OK) {
            coredaq_close(dev);
            return rc;
        }
        snprintf(dev->idn_cache, sizeof(dev->idn_cache), "%s", payload);
    }

    for (i = 0; i < COREDAQ_NUM_HEADS; i += 1) {
        dev->factory_zero_adc[i] = 0;
        dev->linear_zero_adc[i] = 0;
    }

    if (strcmp(dev->frontend, "LINEAR") == 0) {
        (void)coredaq_load_linear_calibration(dev);
        (void)coredaq_refresh_factory_zeros(dev, dev->factory_zero_adc);
        for (i = 0; i < COREDAQ_NUM_HEADS; i += 1) {
            dev->linear_zero_adc[i] = dev->factory_zero_adc[i];
        }
    } else if (strcmp(dev->frontend, "LOG") == 0) {
        (void)coredaq_load_log_calibration(dev);
    }

    return COREDAQ_OK;
}

void coredaq_close(coredaq_device_t *dev) {
    if (!dev) return;
    if (dev->is_open) serial_close(dev);
    dev->is_open = 0;
}

int coredaq_is_open(const coredaq_device_t *dev) {
    return dev ? dev->is_open : 0;
}

const char *coredaq_last_error(const coredaq_device_t *dev) {
    if (!dev || !dev->last_error[0]) return "";
    return dev->last_error;
}

coredaq_result_t coredaq_set_inter_command_gap_ms(coredaq_device_t *dev, int gap_ms) {
    if (!dev || gap_ms < 0) return COREDAQ_ERR_INVALID_ARG;
    if (ensure_open(dev) != COREDAQ_OK) return COREDAQ_ERR_NOT_OPEN;
    dev->inter_gap_ms = gap_ms;
    return COREDAQ_OK;
}

coredaq_result_t coredaq_get_inter_command_gap_ms(const coredaq_device_t *dev, int *out_gap_ms) {
    if (!dev || !out_gap_ms) return COREDAQ_ERR_INVALID_ARG;
    *out_gap_ms = dev->inter_gap_ms;
    return COREDAQ_OK;
}

coredaq_result_t coredaq_query(coredaq_device_t *dev, const char *cmd, char *out_payload, size_t out_payload_len) {
    if (!dev || !cmd || !*cmd) return COREDAQ_ERR_INVALID_ARG;
    if (ensure_open(dev) != COREDAQ_OK) return COREDAQ_ERR_NOT_OPEN;
    return query_internal(dev, cmd, out_payload, out_payload_len);
}

coredaq_result_t coredaq_write(coredaq_device_t *dev, const char *cmd) {
    char payload[64];
    return coredaq_query(dev, cmd, payload, sizeof(payload));
}

coredaq_result_t coredaq_idn(coredaq_device_t *dev, char *out_idn, size_t out_idn_len) {
    if (!dev || !out_idn || out_idn_len == 0) return COREDAQ_ERR_INVALID_ARG;
    if (ensure_open(dev) != COREDAQ_OK) return COREDAQ_ERR_NOT_OPEN;
    if (!dev->idn_cache[0]) {
        char payload[256];
        coredaq_result_t rc = query_internal(dev, "IDN?", payload, sizeof(payload));
        if (rc != COREDAQ_OK) return rc;
        snprintf(dev->idn_cache, sizeof(dev->idn_cache), "%s", payload);
    }
    snprintf(out_idn, out_idn_len, "%s", dev->idn_cache);
    return COREDAQ_OK;
}

coredaq_result_t coredaq_frontend_type(coredaq_device_t *dev, char *out_type, size_t out_type_len) {
    if (!dev || !out_type || out_type_len == 0) return COREDAQ_ERR_INVALID_ARG;
    if (ensure_open(dev) != COREDAQ_OK) return COREDAQ_ERR_NOT_OPEN;
    if (!dev->frontend[0] || strcmp(dev->frontend, "UNKNOWN") == 0) {
        coredaq_result_t rc = detect_frontend(dev);
        if (rc != COREDAQ_OK) return rc;
    }
    snprintf(out_type, out_type_len, "%s", dev->frontend);
    return COREDAQ_OK;
}

coredaq_result_t coredaq_get_gains(coredaq_device_t *dev, int out_gains[COREDAQ_NUM_HEADS]) {
    char payload[256];
    char tmp[256];
    char *tok;
    int found = 0;
    coredaq_result_t rc;
    if (!dev || !out_gains) return COREDAQ_ERR_INVALID_ARG;
    if (ensure_open(dev) != COREDAQ_OK) return COREDAQ_ERR_NOT_OPEN;

    rc = query_internal(dev, "GAINS?", payload, sizeof(payload));
    if (rc != COREDAQ_OK) return rc;

    out_gains[0] = out_gains[1] = out_gains[2] = out_gains[3] = 0;
    snprintf(tmp, sizeof(tmp), "%s", payload);
    tok = strtok(tmp, " ,");
    while (tok) {
        char *eq = strchr(tok, '=');
        if (eq) {
            long v = strtol(eq + 1, NULL, 0);
            if (STRNICMP(tok, "HEAD1", 5) == 0) { out_gains[0] = (int)v; found += 1; }
            else if (STRNICMP(tok, "HEAD2", 5) == 0) { out_gains[1] = (int)v; found += 1; }
            else if (STRNICMP(tok, "HEAD3", 5) == 0) { out_gains[2] = (int)v; found += 1; }
            else if (STRNICMP(tok, "HEAD4", 5) == 0) { out_gains[3] = (int)v; found += 1; }
        }
        tok = strtok(NULL, " ,");
    }
    if (found < 4) {
        set_error(dev, "Unexpected GAINS? payload: %s", payload);
        return COREDAQ_ERR_PROTOCOL;
    }
    return COREDAQ_OK;
}

coredaq_result_t coredaq_set_gain(coredaq_device_t *dev, int head_1_to_4, int gain_0_to_7) {
    char cmd[64];
    if (!dev || head_1_to_4 < 1 || head_1_to_4 > 4 || gain_0_to_7 < 0 || gain_0_to_7 > 7) {
        return COREDAQ_ERR_INVALID_ARG;
    }
    snprintf(cmd, sizeof(cmd), "GAIN %d %d", head_1_to_4, gain_0_to_7);
    return coredaq_write(dev, cmd);
}

coredaq_result_t coredaq_get_freq_hz(coredaq_device_t *dev, int *out_hz) {
    char payload[64];
    coredaq_result_t rc;
    if (!dev || !out_hz) return COREDAQ_ERR_INVALID_ARG;
    rc = query_internal(dev, "FREQ?", payload, sizeof(payload));
    if (rc != COREDAQ_OK) return rc;
    *out_hz = (int)strtol(payload, NULL, 0);
    return COREDAQ_OK;
}

coredaq_result_t coredaq_set_freq_hz(coredaq_device_t *dev, int hz) {
    char cmd[64];
    if (!dev || hz <= 0 || hz > 100000) return COREDAQ_ERR_INVALID_ARG;
    snprintf(cmd, sizeof(cmd), "FREQ %d", hz);
    return coredaq_write(dev, cmd);
}

coredaq_result_t coredaq_get_oversampling(coredaq_device_t *dev, int *out_os_idx) {
    char payload[64];
    coredaq_result_t rc;
    if (!dev || !out_os_idx) return COREDAQ_ERR_INVALID_ARG;
    rc = query_internal(dev, "OS?", payload, sizeof(payload));
    if (rc != COREDAQ_OK) return rc;
    *out_os_idx = (int)strtol(payload, NULL, 0);
    return COREDAQ_OK;
}

coredaq_result_t coredaq_set_oversampling(coredaq_device_t *dev, int os_idx) {
    char cmd[64];
    if (!dev || os_idx < 0 || os_idx > 7) return COREDAQ_ERR_INVALID_ARG;
    snprintf(cmd, sizeof(cmd), "OS %d", os_idx);
    return coredaq_write(dev, cmd);
}

coredaq_result_t coredaq_get_channel_mask_info(coredaq_device_t *dev, int *out_mask, int *out_active_channels, int *out_frame_bytes) {
    char payload[128];
    char *m;
    char *ch;
    char *fb;
    coredaq_result_t rc;
    if (!dev) return COREDAQ_ERR_INVALID_ARG;
    rc = query_internal(dev, "CHMASK?", payload, sizeof(payload));
    if (rc != COREDAQ_OK) return rc;

    m = strstr(payload, "MASK=");
    ch = strstr(payload, "CH=");
    fb = strstr(payload, "FB=");
    if (!m) {
        set_error(dev, "Unexpected CHMASK? payload: %s", payload);
        return COREDAQ_ERR_PROTOCOL;
    }
    if (out_mask) *out_mask = (int)strtol(m + 5, NULL, 0) & 0x0F;
    if (out_active_channels) *out_active_channels = ch ? (int)strtol(ch + 3, NULL, 0) : 4;
    if (out_frame_bytes) *out_frame_bytes = fb ? (int)strtol(fb + 3, NULL, 0) : 8;
    return COREDAQ_OK;
}

coredaq_result_t coredaq_get_channel_mask(coredaq_device_t *dev, int *out_mask) {
    return coredaq_get_channel_mask_info(dev, out_mask, NULL, NULL);
}

coredaq_result_t coredaq_set_channel_mask(coredaq_device_t *dev, int mask) {
    char cmd[64];
    if (!dev) return COREDAQ_ERR_INVALID_ARG;
    mask &= 0x0F;
    if (mask == 0) return COREDAQ_ERR_INVALID_ARG;
    snprintf(cmd, sizeof(cmd), "CHMASK 0x%X", mask);
    return coredaq_write(dev, cmd);
}

static float u32hex_to_float(const char *hex, int *ok) {
    unsigned long u = strtoul(hex, NULL, 16);
    uint32_t bits = (uint32_t)u;
    float f;
    if (ok) *ok = 0;
    memcpy(&f, &bits, sizeof(f));
    if (ok) *ok = 1;
    return f;
}

coredaq_result_t coredaq_load_linear_calibration(coredaq_device_t *dev) {
    int h, g;
    if (!dev) return COREDAQ_ERR_INVALID_ARG;
    for (h = 1; h <= COREDAQ_NUM_HEADS; h += 1) {
        for (g = 0; g < COREDAQ_NUM_GAINS; g += 1) {
            char cmd[32];
            char payload[256];
            char tmp[256];
            char *tok;
            const char *sh = NULL;
            const char *ih = NULL;
            int ok1 = 0;
            int ok2 = 0;
            coredaq_result_t rc;
            snprintf(cmd, sizeof(cmd), "CAL %d %d", h, g);
            rc = query_internal(dev, cmd, payload, sizeof(payload));
            if (rc != COREDAQ_OK) return rc;
            snprintf(tmp, sizeof(tmp), "%s", payload);
            tok = strtok(tmp, " ");
            while (tok) {
                if (strncmp(tok, "S=", 2) == 0) sh = tok + 2;
                else if (strncmp(tok, "I=", 2) == 0) ih = tok + 2;
                tok = strtok(NULL, " ");
            }
            if (!sh || !ih) {
                set_error(dev, "Malformed CAL payload: %s", payload);
                return COREDAQ_ERR_PROTOCOL;
            }
            dev->cal_slope[h - 1][g] = u32hex_to_float(sh, &ok1);
            dev->cal_intercept[h - 1][g] = u32hex_to_float(ih, &ok2);
            if (!ok1 || !ok2 || !isfinite(dev->cal_slope[h - 1][g])) {
                set_error(dev, "Invalid CAL payload: %s", payload);
                return COREDAQ_ERR_PROTOCOL;
            }
        }
    }
    dev->linear_cal_loaded = 1;
    return COREDAQ_OK;
}
static coredaq_result_t read_exact(coredaq_device_t *dev, unsigned char *out, size_t need, int idle_timeout_ms, int overall_timeout_ms) {
    size_t got = 0;
    unsigned long long deadline = now_ms() + (unsigned long long)overall_timeout_ms;
    unsigned long long last_rx = now_ms();
    while (got < need) {
        size_t n = 0;
        coredaq_result_t rc = serial_read_some(dev, out + got, need - got, &n, 50);
        if (rc == COREDAQ_OK && n > 0) {
            got += n;
            last_rx = now_ms();
            continue;
        }
        if (rc != COREDAQ_OK && rc != COREDAQ_ERR_TIMEOUT) {
            return rc;
        }
        if ((int)(now_ms() - last_rx) > idle_timeout_ms) {
            set_error(dev, "USB read idle timeout at %zu/%zu bytes", got, need);
            return COREDAQ_ERR_TIMEOUT;
        }
        if (now_ms() > deadline) {
            set_error(dev, "USB read overall timeout at %zu/%zu bytes", got, need);
            return COREDAQ_ERR_TIMEOUT;
        }
    }
    return COREDAQ_OK;
}

coredaq_result_t coredaq_load_log_calibration(coredaq_device_t *dev) {
    int h;
    if (!dev) return COREDAQ_ERR_INVALID_ARG;

    for (h = 1; h <= COREDAQ_NUM_HEADS; h += 1) {
        char cmd[32];
        char header[256];
        char done[64];
        int n_pts = 0;
        int rb = 0;
        int idx = h - 1;
        unsigned char *payload = NULL;
        coredaq_result_t rc;

        snprintf(cmd, sizeof(cmd), "LOGCAL %d", h);
        rc = write_line(dev, cmd);
        if (rc != COREDAQ_OK) return rc;
        rc = read_line(dev, header, sizeof(header), 2000);
        if (rc != COREDAQ_OK) {
            if (h > 1 && dev->log_n[0] > 0 && dev->log_v[0] && dev->log_log10p[0]) {
                dev->log_n[idx] = dev->log_n[0];
                free(dev->log_v[idx]);
                free(dev->log_log10p[idx]);
                dev->log_v[idx] = (double *)malloc(sizeof(double) * (size_t)dev->log_n[0]);
                dev->log_log10p[idx] = (double *)malloc(sizeof(double) * (size_t)dev->log_n[0]);
                if (!dev->log_v[idx] || !dev->log_log10p[idx]) return COREDAQ_ERR_NO_MEMORY;
                memcpy(dev->log_v[idx], dev->log_v[0], sizeof(double) * (size_t)dev->log_n[0]);
                memcpy(dev->log_log10p[idx], dev->log_log10p[0], sizeof(double) * (size_t)dev->log_n[0]);
                continue;
            }
            return rc;
        }

        {
            char *pn = strstr(header, "N=");
            char *prb = strstr(header, "RB=");
            if (!pn || !prb) {
                set_error(dev, "Malformed LOGCAL header: %s", header);
                return COREDAQ_ERR_PROTOCOL;
            }
            n_pts = (int)strtol(pn + 2, NULL, 10);
            rb = (int)strtol(prb + 3, NULL, 10);
            if (n_pts <= 0 || rb != 6) {
                set_error(dev, "Unexpected LOGCAL header: %s", header);
                return COREDAQ_ERR_PROTOCOL;
            }
        }

        payload = (unsigned char *)malloc((size_t)n_pts * (size_t)rb);
        if (!payload) return COREDAQ_ERR_NO_MEMORY;

        rc = read_exact(dev, payload, (size_t)n_pts * (size_t)rb, 2000, 15000);
        if (rc != COREDAQ_OK) {
            free(payload);
            return rc;
        }

        rc = read_line(dev, done, sizeof(done), 2000);
        if (rc != COREDAQ_OK || strcmp(done, "OK DONE") != 0) {
            free(payload);
            set_error(dev, "LOGCAL missing terminator");
            return COREDAQ_ERR_PROTOCOL;
        }

        free(dev->log_v[idx]);
        free(dev->log_log10p[idx]);
        dev->log_v[idx] = (double *)malloc(sizeof(double) * (size_t)n_pts);
        dev->log_log10p[idx] = (double *)malloc(sizeof(double) * (size_t)n_pts);
        if (!dev->log_v[idx] || !dev->log_log10p[idx]) {
            free(payload);
            return COREDAQ_ERR_NO_MEMORY;
        }
        dev->log_n[idx] = n_pts;

        {
            int i;
            for (i = 0; i < n_pts; i += 1) {
                const unsigned char *row = payload + ((size_t)i * 6u);
                uint16_t v_mV = (uint16_t)row[0] | ((uint16_t)row[1] << 8);
                int32_t q16 = (int32_t)((uint32_t)row[2] | ((uint32_t)row[3] << 8) | ((uint32_t)row[4] << 16) | ((uint32_t)row[5] << 24));
                dev->log_v[idx][i] = (double)v_mV / 1000.0;
                dev->log_log10p[idx][i] = (double)q16 / 65536.0;
            }
        }
        free(payload);
    }

    dev->log_cal_loaded = 1;
    return COREDAQ_OK;
}

coredaq_result_t coredaq_refresh_factory_zeros(coredaq_device_t *dev, int out_factory_zeros[COREDAQ_NUM_HEADS]) {
    char payload[256];
    char tmp[256];
    char *tok;
    int z[4] = {0, 0, 0, 0};
    int count = 0;
    coredaq_result_t rc;
    if (!dev) return COREDAQ_ERR_INVALID_ARG;
    if (strcmp(dev->frontend, "LINEAR") != 0) {
        if (out_factory_zeros) memset(out_factory_zeros, 0, sizeof(int) * 4);
        return COREDAQ_OK;
    }

    rc = query_internal(dev, "FACTORY_ZEROS?", payload, sizeof(payload));
    if (rc != COREDAQ_OK) return rc;

    snprintf(tmp, sizeof(tmp), "%s", payload);
    tok = strtok(tmp, " ,");
    while (tok) {
        char *eq = strchr(tok, '=');
        if (eq) {
            long v = strtol(eq + 1, NULL, 0);
            if (STRNICMP(tok, "h1", 2) == 0) { z[0] = (int)v; count += 1; }
            else if (STRNICMP(tok, "h2", 2) == 0) { z[1] = (int)v; count += 1; }
            else if (STRNICMP(tok, "h3", 2) == 0) { z[2] = (int)v; count += 1; }
            else if (STRNICMP(tok, "h4", 2) == 0) { z[3] = (int)v; count += 1; }
        } else if (count < 4) {
            z[count] = (int)strtol(tok, NULL, 0);
            count += 1;
        }
        tok = strtok(NULL, " ,");
    }

    if (count < 4) {
        set_error(dev, "Unexpected FACTORY_ZEROS? payload: %s", payload);
        return COREDAQ_ERR_PROTOCOL;
    }

    memcpy(dev->factory_zero_adc, z, sizeof(z));
    if (out_factory_zeros) memcpy(out_factory_zeros, z, sizeof(z));
    return COREDAQ_OK;
}

coredaq_result_t coredaq_get_linear_zero_adc(coredaq_device_t *dev, int out_zero_adc[COREDAQ_NUM_HEADS]) {
    if (!dev || !out_zero_adc) return COREDAQ_ERR_INVALID_ARG;
    memcpy(out_zero_adc, dev->linear_zero_adc, sizeof(dev->linear_zero_adc));
    return COREDAQ_OK;
}

coredaq_result_t coredaq_set_soft_zero_adc(coredaq_device_t *dev, const int zero_adc[COREDAQ_NUM_HEADS]) {
    if (!dev || !zero_adc) return COREDAQ_ERR_INVALID_ARG;
    memcpy(dev->linear_zero_adc, zero_adc, sizeof(dev->linear_zero_adc));
    return COREDAQ_OK;
}

coredaq_result_t coredaq_restore_factory_zero(coredaq_device_t *dev) {
    if (!dev) return COREDAQ_ERR_INVALID_ARG;
    memcpy(dev->linear_zero_adc, dev->factory_zero_adc, sizeof(dev->linear_zero_adc));
    return COREDAQ_OK;
}

static void parse_snapshot(const char *payload, int out_codes[4], int out_gains[4]) {
    char tmp[512];
    char *tok;
    int i = 0;
    out_codes[0] = out_codes[1] = out_codes[2] = out_codes[3] = 0;
    out_gains[0] = out_gains[1] = out_gains[2] = out_gains[3] = 0;

    snprintf(tmp, sizeof(tmp), "%s", payload ? payload : "");
    tok = strtok(tmp, ",");
    while (tok && i < 4) {
        trim(tok);
        out_codes[i++] = (int)strtol(tok, NULL, 0);
        tok = strtok(NULL, ",");
    }

    {
        const char *p = payload;
        while (p && (p = strstr(p, "G=")) != NULL) {
            int idx = -1;
            int val = 0;
            if (sscanf(p, "G=%d=%d", &idx, &val) == 2) {
                if (idx >= 1 && idx <= 4) out_gains[idx - 1] = val;
            }
            p += 2;
        }
    }
}

static double interp_log_power(const coredaq_device_t *dev, int ch, double volts) {
    const double *x;
    const double *y;
    int n;
    int lo, hi;
    if (!dev || ch < 0 || ch >= 4) return 0.0;
    n = dev->log_n[ch];
    x = dev->log_v[ch];
    y = dev->log_log10p[ch];
    if (!x || !y || n <= 0) return 0.0;
    if (volts <= x[0]) return pow(10.0, y[0]);
    if (volts >= x[n - 1]) return pow(10.0, y[n - 1]);

    lo = 0;
    hi = n - 1;
    while (hi - lo > 1) {
        int mid = (lo + hi) / 2;
        if (x[mid] <= volts) lo = mid;
        else hi = mid;
    }
    if (x[hi] == x[lo]) return pow(10.0, y[lo]);
    {
        double t = (volts - x[lo]) / (x[hi] - x[lo]);
        double v = y[lo] * (1.0 - t) + y[hi] * t;
        return pow(10.0, v);
    }
}
coredaq_result_t coredaq_snapshot_adc(coredaq_device_t *dev, int n_frames, int timeout_ms, int poll_hz, int out_codes[4], int out_gains[4]) {
    char cmd[64];
    char payload[512];
    coredaq_result_t rc;
    unsigned long long deadline;
    int poll_ms;

    if (!dev || !out_codes || !out_gains || n_frames <= 0) return COREDAQ_ERR_INVALID_ARG;

    snprintf(cmd, sizeof(cmd), "SNAP %d", n_frames);
    rc = query_internal(dev, cmd, payload, sizeof(payload));
    if (rc != COREDAQ_OK) return rc;

    poll_ms = (poll_hz > 0) ? (1000 / poll_hz) : 5;
    if (poll_ms < 2) poll_ms = 2;
    deadline = now_ms() + (unsigned long long)((timeout_ms > 0) ? timeout_ms : 1000);

    while (now_ms() <= deadline) {
        rc = query_internal(dev, "SNAP?", payload, sizeof(payload));
        if (rc == COREDAQ_ERR_BUSY) {
            sleep_ms(poll_ms);
            continue;
        }
        if (rc != COREDAQ_OK) return rc;

        parse_snapshot(payload, out_codes, out_gains);
        if (strcmp(dev->frontend, "LINEAR") == 0 && out_gains[0] == 0 && out_gains[1] == 0 && out_gains[2] == 0 && out_gains[3] == 0) {
            (void)coredaq_get_gains(dev, out_gains);
        }
        return COREDAQ_OK;
    }

    set_error(dev, "SNAP timeout");
    return COREDAQ_ERR_TIMEOUT;
}

coredaq_result_t coredaq_snapshot_adc_zeroed(coredaq_device_t *dev, int n_frames, int timeout_ms, int poll_hz, int out_codes[4], int out_gains[4]) {
    int i;
    coredaq_result_t rc = coredaq_snapshot_adc(dev, n_frames, timeout_ms, poll_hz, out_codes, out_gains);
    if (rc != COREDAQ_OK) return rc;
    if (strcmp(dev->frontend, "LINEAR") == 0) {
        for (i = 0; i < 4; i += 1) out_codes[i] -= dev->linear_zero_adc[i];
    }
    return COREDAQ_OK;
}

coredaq_result_t coredaq_snapshot_mv(coredaq_device_t *dev, int n_frames, int timeout_ms, int poll_hz, float out_mv[4], int out_gains[4]) {
    int i;
    int codes[4];
    coredaq_result_t rc;
    if (!dev || !out_mv || !out_gains) return COREDAQ_ERR_INVALID_ARG;
    rc = coredaq_snapshot_adc_zeroed(dev, n_frames, timeout_ms, poll_hz, codes, out_gains);
    if (rc != COREDAQ_OK) return rc;
    for (i = 0; i < 4; i += 1) {
        out_mv[i] = (float)codes[i] * (float)COREDAQ_ADC_LSB_MV;
    }
    return COREDAQ_OK;
}

coredaq_result_t coredaq_snapshot_volts(coredaq_device_t *dev, int n_frames, int timeout_ms, int poll_hz, float out_volts[4], int out_gains[4]) {
    float mv[4];
    int i;
    coredaq_result_t rc = coredaq_snapshot_mv(dev, n_frames, timeout_ms, poll_hz, mv, out_gains);
    if (rc != COREDAQ_OK) return rc;
    for (i = 0; i < 4; i += 1) out_volts[i] = mv[i] / 1000.0f;
    return COREDAQ_OK;
}

coredaq_result_t coredaq_snapshot_w(coredaq_device_t *dev, int n_frames, int timeout_ms, int poll_hz, float log_deadband_mv, float out_w[4], int out_gains[4]) {
    float mv[4];
    int i;
    coredaq_result_t rc;
    if (!dev || !out_w || !out_gains) return COREDAQ_ERR_INVALID_ARG;
    rc = coredaq_snapshot_mv(dev, n_frames, timeout_ms, poll_hz, mv, out_gains);
    if (rc != COREDAQ_OK) return rc;

    if (strcmp(dev->frontend, "LINEAR") == 0 && !dev->linear_cal_loaded) {
        rc = coredaq_load_linear_calibration(dev);
        if (rc != COREDAQ_OK) return rc;
    }

    for (i = 0; i < 4; i += 1) {
        if (strcmp(dev->frontend, "LOG") == 0) {
            float db = (log_deadband_mv > 0.0f) ? log_deadband_mv : dev->log_deadband_mv;
            if (fabsf(mv[i]) < db) out_w[i] = 0.0f;
            else out_w[i] = (float)interp_log_power(dev, i, (double)mv[i] / 1000.0);
        } else {
            int g = out_gains[i];
            float slope;
            if (g < 0 || g > 7) g = 0;
            slope = dev->cal_slope[i][g];
            if (fabsf(slope) < 1e-9f) return COREDAQ_ERR_PROTOCOL;
            out_w[i] = mv[i] / slope;
        }
    }
    return COREDAQ_OK;
}

coredaq_result_t coredaq_state_enum(coredaq_device_t *dev, int *out_state) {
    char payload[64];
    coredaq_result_t rc;
    if (!dev || !out_state) return COREDAQ_ERR_INVALID_ARG;
    rc = query_internal(dev, "STATE?", payload, sizeof(payload));
    if (rc != COREDAQ_OK) return rc;
    *out_state = (int)strtol(payload, NULL, 0);
    return COREDAQ_OK;
}

coredaq_result_t coredaq_arm_acquisition(coredaq_device_t *dev, int frames, int use_trigger, int trigger_rising) {
    char cmd[64];
    if (!dev || frames <= 0) return COREDAQ_ERR_INVALID_ARG;
    if (use_trigger) snprintf(cmd, sizeof(cmd), "TRIGARM %d %c", frames, trigger_rising ? 'R' : 'F');
    else snprintf(cmd, sizeof(cmd), "ACQ ARM %d", frames);
    return coredaq_write(dev, cmd);
}

coredaq_result_t coredaq_start_acquisition(coredaq_device_t *dev) { return coredaq_write(dev, "ACQ START"); }
coredaq_result_t coredaq_stop_acquisition(coredaq_device_t *dev) { return coredaq_write(dev, "ACQ STOP"); }

coredaq_result_t coredaq_frames_remaining(coredaq_device_t *dev, int *out_frames_left) {
    char payload[64];
    coredaq_result_t rc;
    if (!dev || !out_frames_left) return COREDAQ_ERR_INVALID_ARG;
    rc = query_internal(dev, "LEFT?", payload, sizeof(payload));
    if (rc != COREDAQ_OK) return rc;
    *out_frames_left = (int)strtol(payload, NULL, 0);
    return COREDAQ_OK;
}

coredaq_result_t coredaq_wait_for_completion(coredaq_device_t *dev, int timeout_ms, int poll_ms) {
    unsigned long long deadline;
    if (!dev) return COREDAQ_ERR_INVALID_ARG;
    if (poll_ms <= 0) poll_ms = 50;
    deadline = now_ms() + (unsigned long long)((timeout_ms > 0) ? timeout_ms : 60000);
    while (now_ms() <= deadline) {
        int state = 0;
        coredaq_result_t rc = coredaq_state_enum(dev, &state);
        if (rc != COREDAQ_OK) return rc;
        if (state == 4) return COREDAQ_OK;
        sleep_ms(poll_ms);
    }
    set_error(dev, "Acquisition timeout");
    return COREDAQ_ERR_TIMEOUT;
}

coredaq_result_t coredaq_transfer_frames_adc_interleaved(coredaq_device_t *dev, int frames, int16_t *out_samples, size_t out_sample_count, int *out_mask, int *out_active_channels) {
    int mask = 0, active = 0, frame_bytes = 0;
    int bytes_needed;
    int samples_needed;
    unsigned char *raw;
    char cmd[64];
    char payload[128];
    int i;
    coredaq_result_t rc;

    if (!dev || frames <= 0 || !out_samples) return COREDAQ_ERR_INVALID_ARG;
    rc = coredaq_get_channel_mask_info(dev, &mask, &active, &frame_bytes);
    if (rc != COREDAQ_OK) return rc;
    if (active <= 0) return COREDAQ_ERR_PROTOCOL;

    bytes_needed = frames * frame_bytes;
    samples_needed = frames * active;
    if ((size_t)samples_needed > out_sample_count) return COREDAQ_ERR_INVALID_ARG;

    raw = (unsigned char *)malloc((size_t)bytes_needed);
    if (!raw) return COREDAQ_ERR_NO_MEMORY;

    serial_flush_rx(dev);
    snprintf(cmd, sizeof(cmd), "XFER %d", bytes_needed);
    rc = write_line(dev, cmd);
    if (rc != COREDAQ_OK) { free(raw); return rc; }
    rc = read_status_payload(dev, payload, sizeof(payload));
    if (rc != COREDAQ_OK) { free(raw); return rc; }

    rc = read_exact(dev, raw, (size_t)bytes_needed, 6000, (bytes_needed / 1000000) * 12000 + 8000);
    if (rc != COREDAQ_OK) { free(raw); return rc; }

    for (i = 0; i < samples_needed; i += 1) {
        uint16_t v = (uint16_t)raw[(size_t)i * 2u] | ((uint16_t)raw[(size_t)i * 2u + 1u] << 8);
        out_samples[i] = (int16_t)v;
    }

    if (out_mask) *out_mask = mask;
    if (out_active_channels) *out_active_channels = active;
    free(raw);
    return COREDAQ_OK;
}

coredaq_result_t coredaq_transfer_frames_adc(coredaq_device_t *dev, int frames, int16_t *ch1, int16_t *ch2, int16_t *ch3, int16_t *ch4, size_t per_channel_len) {
    int mask = 0;
    int active = 0;
    int idx[4] = {0, 1, 2, 3};
    int16_t *tmp;
    int i;
    int p;
    coredaq_result_t rc;
    if (!dev || frames <= 0 || per_channel_len < (size_t)frames || !ch1 || !ch2 || !ch3 || !ch4) return COREDAQ_ERR_INVALID_ARG;

    tmp = (int16_t *)malloc((size_t)frames * 4u * sizeof(int16_t));
    if (!tmp) return COREDAQ_ERR_NO_MEMORY;

    memset(ch1, 0, per_channel_len * sizeof(int16_t));
    memset(ch2, 0, per_channel_len * sizeof(int16_t));
    memset(ch3, 0, per_channel_len * sizeof(int16_t));
    memset(ch4, 0, per_channel_len * sizeof(int16_t));

    rc = coredaq_transfer_frames_adc_interleaved(dev, frames, tmp, (size_t)frames * 4u, &mask, &active);
    if (rc != COREDAQ_OK) { free(tmp); return rc; }

    active_indices_from_mask(mask, idx);
    for (i = 0; i < frames; i += 1) {
        for (p = 0; p < active; p += 1) {
            int ch = idx[p];
            int16_t v = tmp[(size_t)i * (size_t)active + (size_t)p];
            if (ch == 0) ch1[i] = v;
            else if (ch == 1) ch2[i] = v;
            else if (ch == 2) ch3[i] = v;
            else if (ch == 3) ch4[i] = v;
        }
    }

    free(tmp);
    return COREDAQ_OK;
}

static void codes_to_mv(coredaq_device_t *dev, const int16_t *codes, int n, int ch_idx, float *out, float log_deadband_mv) {
    int i;
    for (i = 0; i < n; i += 1) {
        int corr = (int)codes[i];
        float mv;
        if (strcmp(dev->frontend, "LINEAR") == 0) corr -= dev->linear_zero_adc[ch_idx];
        mv = (float)corr * (float)COREDAQ_ADC_LSB_MV;
        if (strcmp(dev->frontend, "LOG") == 0) {
            float db = (log_deadband_mv > 0.0f) ? log_deadband_mv : dev->log_deadband_mv;
            if (fabsf(mv) < db) mv = 0.0f;
        }
        out[i] = mv;
    }
}

coredaq_result_t coredaq_transfer_frames_mv(coredaq_device_t *dev, int frames, float *ch1, float *ch2, float *ch3, float *ch4, size_t per_channel_len, float log_deadband_mv) {
    int16_t *c1, *c2, *c3, *c4;
    coredaq_result_t rc;
    if (!dev || frames <= 0 || per_channel_len < (size_t)frames || !ch1 || !ch2 || !ch3 || !ch4) return COREDAQ_ERR_INVALID_ARG;
    c1 = (int16_t *)malloc((size_t)frames * sizeof(int16_t));
    c2 = (int16_t *)malloc((size_t)frames * sizeof(int16_t));
    c3 = (int16_t *)malloc((size_t)frames * sizeof(int16_t));
    c4 = (int16_t *)malloc((size_t)frames * sizeof(int16_t));
    if (!c1 || !c2 || !c3 || !c4) { free(c1); free(c2); free(c3); free(c4); return COREDAQ_ERR_NO_MEMORY; }

    rc = coredaq_transfer_frames_adc(dev, frames, c1, c2, c3, c4, (size_t)frames);
    if (rc != COREDAQ_OK) { free(c1); free(c2); free(c3); free(c4); return rc; }

    codes_to_mv(dev, c1, frames, 0, ch1, log_deadband_mv);
    codes_to_mv(dev, c2, frames, 1, ch2, log_deadband_mv);
    codes_to_mv(dev, c3, frames, 2, ch3, log_deadband_mv);
    codes_to_mv(dev, c4, frames, 3, ch4, log_deadband_mv);

    free(c1); free(c2); free(c3); free(c4);
    return COREDAQ_OK;
}
coredaq_result_t coredaq_transfer_frames_volts(coredaq_device_t *dev, int frames, float *ch1, float *ch2, float *ch3, float *ch4, size_t per_channel_len, float log_deadband_mv) {
    int i;
    coredaq_result_t rc = coredaq_transfer_frames_mv(dev, frames, ch1, ch2, ch3, ch4, per_channel_len, log_deadband_mv);
    if (rc != COREDAQ_OK) return rc;
    for (i = 0; i < frames; i += 1) {
        ch1[i] /= 1000.0f;
        ch2[i] /= 1000.0f;
        ch3[i] /= 1000.0f;
        ch4[i] /= 1000.0f;
    }
    return COREDAQ_OK;
}

coredaq_result_t coredaq_transfer_frames_w(coredaq_device_t *dev, int frames, float *ch1, float *ch2, float *ch3, float *ch4, size_t per_channel_len, float log_deadband_mv) {
    int i;
    int gains[4] = {0, 0, 0, 0};
    coredaq_result_t rc;
    if (!dev || !ch1 || !ch2 || !ch3 || !ch4 || frames <= 0 || per_channel_len < (size_t)frames) return COREDAQ_ERR_INVALID_ARG;

    rc = coredaq_transfer_frames_mv(dev, frames, ch1, ch2, ch3, ch4, per_channel_len, log_deadband_mv);
    if (rc != COREDAQ_OK) return rc;

    if (strcmp(dev->frontend, "LINEAR") == 0) {
        if (!dev->linear_cal_loaded) {
            rc = coredaq_load_linear_calibration(dev);
            if (rc != COREDAQ_OK) return rc;
        }
        rc = coredaq_get_gains(dev, gains);
        if (rc != COREDAQ_OK) return rc;

        for (i = 0; i < frames; i += 1) {
            int g1 = (gains[0] >= 0 && gains[0] < 8) ? gains[0] : 0;
            int g2 = (gains[1] >= 0 && gains[1] < 8) ? gains[1] : 0;
            int g3 = (gains[2] >= 0 && gains[2] < 8) ? gains[2] : 0;
            int g4 = (gains[3] >= 0 && gains[3] < 8) ? gains[3] : 0;
            float s1 = dev->cal_slope[0][g1];
            float s2 = dev->cal_slope[1][g2];
            float s3 = dev->cal_slope[2][g3];
            float s4 = dev->cal_slope[3][g4];
            ch1[i] = (fabsf(s1) > 1e-9f) ? (ch1[i] / s1) : 0.0f;
            ch2[i] = (fabsf(s2) > 1e-9f) ? (ch2[i] / s2) : 0.0f;
            ch3[i] = (fabsf(s3) > 1e-9f) ? (ch3[i] / s3) : 0.0f;
            ch4[i] = (fabsf(s4) > 1e-9f) ? (ch4[i] / s4) : 0.0f;
        }
        return COREDAQ_OK;
    }

    for (i = 0; i < frames; i += 1) {
        ch1[i] = (float)interp_log_power(dev, 0, (double)ch1[i] / 1000.0);
        ch2[i] = (float)interp_log_power(dev, 1, (double)ch2[i] / 1000.0);
        ch3[i] = (float)interp_log_power(dev, 2, (double)ch3[i] / 1000.0);
        ch4[i] = (float)interp_log_power(dev, 3, (double)ch4[i] / 1000.0);
    }
    return COREDAQ_OK;
}

coredaq_result_t coredaq_stream_write_address(coredaq_device_t *dev, int *out_addr) {
    char payload[64];
    coredaq_result_t rc;
    if (!dev || !out_addr) return COREDAQ_ERR_INVALID_ARG;
    rc = query_internal(dev, "ADDR?", payload, sizeof(payload));
    if (rc != COREDAQ_OK) return rc;
    *out_addr = (int)strtol(payload, NULL, 0);
    return COREDAQ_OK;
}

coredaq_result_t coredaq_soft_reset(coredaq_device_t *dev) { return coredaq_write(dev, "SOFTRESET"); }
coredaq_result_t coredaq_i2c_refresh(coredaq_device_t *dev) { return coredaq_write(dev, "I2C REFRESH"); }

coredaq_result_t coredaq_get_head_temperature_c(coredaq_device_t *dev, double *out_temp_c) {
    char payload[64];
    coredaq_result_t rc;
    if (!dev || !out_temp_c) return COREDAQ_ERR_INVALID_ARG;
    rc = query_internal(dev, "TEMP?", payload, sizeof(payload));
    if (rc != COREDAQ_OK) return rc;
    *out_temp_c = strtod(payload, NULL);
    return COREDAQ_OK;
}

coredaq_result_t coredaq_get_head_humidity_pct(coredaq_device_t *dev, double *out_humidity_pct) {
    char payload[64];
    coredaq_result_t rc;
    if (!dev || !out_humidity_pct) return COREDAQ_ERR_INVALID_ARG;
    rc = query_internal(dev, "HUM?", payload, sizeof(payload));
    if (rc != COREDAQ_OK) return rc;
    *out_humidity_pct = strtod(payload, NULL);
    return COREDAQ_OK;
}

coredaq_result_t coredaq_get_die_temperature_c(coredaq_device_t *dev, double *out_temp_c) {
    char payload[64];
    coredaq_result_t rc;
    if (!dev || !out_temp_c) return COREDAQ_ERR_INVALID_ARG;
    rc = query_internal(dev, "DIE_TEMP?", payload, sizeof(payload));
    if (rc != COREDAQ_OK) return rc;
    *out_temp_c = strtod(payload, NULL);
    return COREDAQ_OK;
}

static coredaq_result_t probe_port(const char *port, int timeout_ms) {
    coredaq_device_t *dev = NULL;
    coredaq_result_t rc = coredaq_create(&dev);
    if (rc != COREDAQ_OK) return rc;
    rc = coredaq_open(dev, port, 115200, timeout_ms);
    if (rc == COREDAQ_OK) {
        if (!contains_case_insensitive(dev->idn_cache, "coredaq") && !contains_case_insensitive(dev->idn_cache, "head")) {
            rc = COREDAQ_ERR_PROTOCOL;
        }
    }
    coredaq_destroy(dev);
    return rc;
}

coredaq_result_t coredaq_find_ports(char out_ports[][64], size_t max_ports, size_t *out_count, int timeout_ms) {
    size_t found = 0;
    if (!out_ports || !out_count || max_ports == 0) return COREDAQ_ERR_INVALID_ARG;
#ifdef _WIN32
    {
        int n;
        for (n = 1; n <= 128 && found < max_ports; n += 1) {
            char port[16];
            snprintf(port, sizeof(port), "COM%d", n);
            if (probe_port(port, timeout_ms > 0 ? timeout_ms : 120) == COREDAQ_OK) {
                snprintf(out_ports[found], 64, "%s", port);
                found += 1;
            }
        }
    }
#else
    {
        const char *patterns[] = {"/dev/ttyACM*", "/dev/ttyUSB*", "/dev/tty.usbmodem*", "/dev/tty.usbserial*"};
        size_t p;
        for (p = 0; p < sizeof(patterns) / sizeof(patterns[0]) && found < max_ports; p += 1) {
            glob_t g;
            size_t i;
            memset(&g, 0, sizeof(g));
            if (glob(patterns[p], 0, NULL, &g) != 0) {
                globfree(&g);
                continue;
            }
            for (i = 0; i < g.gl_pathc && found < max_ports; i += 1) {
                const char *port = g.gl_pathv[i];
                if (probe_port(port, timeout_ms > 0 ? timeout_ms : 120) == COREDAQ_OK) {
                    snprintf(out_ports[found], 64, "%s", port);
                    found += 1;
                }
            }
            globfree(&g);
        }
    }
#endif
    *out_count = found;
    return COREDAQ_OK;
}
