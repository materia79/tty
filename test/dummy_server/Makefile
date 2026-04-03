CC ?= gcc
CFLAGS ?= -std=c11 -O2 -Wall -Wextra -pedantic
TARGET ?= dummy_server
SRC := dummy_server.c

.PHONY: all run clean

all: $(TARGET)

$(TARGET): $(SRC)
	$(CC) $(CFLAGS) -o $@ $(SRC)

run: $(TARGET)
	./$(TARGET)

clean:
	rm -f $(TARGET)